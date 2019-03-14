import {ConnectionData as Data, ListenEvent, Opts, Address} from './types';
import run = require('promisify-tuple');
const ping = require('pull-ping');
const pull = require('pull-stream');
const Notify = require('pull-notify');
const msAddress = require('multiserver-address');
const ref = require('ssb-ref');

function isDhtAddress(addr: Address) {
  return addr.substr(0, 4) === 'dht:';
}

function getKeyFromDhtAddress(addr: Address): string {
  const [transport /*, transform */] = addr.split('~');
  const [dhtTag, , remoteId] = transport.split(':');
  if (dhtTag !== 'dht') throw new Error('Invalid DHT address ' + addr);
  const key = remoteId[0] === '@' ? remoteId : '@' + remoteId;
  return key;
}

function inferPublicKey(address: Address): string | undefined {
  if (isDhtAddress(address)) {
    return getKeyFromDhtAddress(address);
  } else {
    return ref.getKeyFromAddress(address);
  }
}

const defaultOpts: Opts = {
  pingTimeout: 5 * 6e4,
};

class ConnHub {
  private readonly _server: any;
  private readonly _pingTimeout: number;
  private readonly _peers: Map<Address, Data>;
  private readonly _notify: any;

  /**
   * Used only to schedule a connect when a disconnect is in progress.
   */
  private readonly _connectRetries: Set<Address>;

  constructor(server: any, opts: Partial<Opts> = defaultOpts) {
    this._server = server;
    this._pingTimeout = opts.pingTimeout || defaultOpts.pingTimeout;
    this._connectRetries = new Set<Address>();
    this._peers = new Map<Address, Data>();
    this._notify = Notify();
    this._init();
  }

  private _init() {
    this._server.on('rpc:connect', this._onRpcConnect.bind(this));
  }

  private _setPeer(address: Address, data: Partial<Data>) {
    const previousData = this._peers.get(address);
    if (previousData) {
      Object.keys(data).forEach(key => {
        const k = key as keyof Data;
        if (typeof data[k] === 'undefined') delete data[k];
      });
      this._peers.set(address, {...previousData, ...data});
    } else if (!data.state && !this._peers.has(address)) {
      // Refuse to add an entry with no state
      // TODO debug log this exceptional case
    } else {
      this._peers.set(address, data as Data);
    }
  }

  private _getPeerByKey(key: string): [Address, Data] | undefined {
    for (let [address, data] of this._peers.entries()) {
      if (data.key === key) return [address, data];
    }
    return undefined;
  }

  private _setupPing(address: Address, rpc: any, key?: string) {
    const pp = ping({serve: true, timeout: this._pingTimeout}, () => {});
    this._notify({type: 'ping', address, key, details: pp} as ListenEvent);
    pull(
      pp,
      rpc.gossip.ping({timeout: this._pingTimeout}, (err: any) => {
        this._notify({
          type: 'ping-failed',
          address,
          key,
          details: err,
        } as ListenEvent);
      }),
      pp,
    );
  }

  private _onRpcConnect(rpc: any, isClient: boolean) {
    // If we're not ready, close this connection immediately:
    if (!this._server.ready() && rpc.id !== this._server.id) return rpc.close();

    // Don't process self connections, whatever that means:
    if (rpc.id === this._server.id) return;

    const peer = this._getPeerByKey(rpc.id);

    if (!peer) {
      // If peer was not registered through the public API, try again a few times
      // in case there was a race condition with ConnHub::connect()
      rpc._connectRetries = rpc._connectRetries || 0;
      if (isClient && rpc._connectRetries < 4) {
        setTimeout(() => {
          this._onRpcConnect(rpc, isClient);
        }, 200);
        rpc._connectRetries += 1;
      } else {
        // TODO debug log that there was a client who connected
        // through means other than the conn-hub API
      }
      return;
    }

    const [address, data] = peer;
    const key = data.key;

    const state = 'connected';
    const disconnect: Data['disconnect'] = cb => rpc.close(true, cb);
    this._setPeer(address, {state, key, disconnect});
    this._notify({type: state, address, key, details: rpc} as ListenEvent);

    if (isClient) this._setupPing(address, rpc, key);

    rpc.on('closed', () => {
      this._peers.delete(address);
      this._notify({type: 'disconnected', address, key} as ListenEvent);
    });
  }

  ///////////////
  //// PUBLIC API
  ///////////////

  public async connect(address: Address): Promise<false | object> {
    if (!msAddress.check(address)) {
      throw new Error('The given address is not a valid multiserver-address');
    }

    if (this._peers.has(address)) {
      const peer = this._peers.get(address)!;
      if (peer.state === 'connecting' || peer.state === 'connected') {
        return false;
      } else if (peer.state === 'disconnecting') {
        // If disconnecting, schedule a connect() after disconnection completed
        this._connectRetries.add(address);
        return false;
      } else {
        // TODO debug log unexpected case
      }
    }

    const state: Data['state'] = 'connecting';
    const key = inferPublicKey(address);
    this._setPeer(address, {state, key});
    this._notify({type: state, address, key} as ListenEvent);

    const [err, rpc] = await run<any>(this._server.connect)(address);
    if (err) {
      this._peers.delete(address);
      this._notify({
        type: 'connecting-failed',
        address,
        key,
        details: err,
      } as ListenEvent);
      throw err;
    }

    const peer = this._peers.get(address);
    if (!peer || peer.state !== 'connected') {
      const state: Data['state'] = 'connected';
      this._setPeer(address, {state, key});
      this._notify({type: state, address, key, details: rpc} as ListenEvent);
    }
    return rpc;
  }

  public async disconnect(address: Address): Promise<boolean> {
    if (!msAddress.check(address)) {
      throw new Error('The given address is not a valid multiserver-address');
    }

    if (!this._peers.has(address)) return false;

    const peer = this._peers.get(address)!;

    const key = inferPublicKey(address);
    if (peer.state !== 'disconnecting') {
      const state: Data['state'] = 'disconnecting';
      this._setPeer(address, {state, key});
      this._notify({type: state, address, key} as ListenEvent);
    }

    if (peer.disconnect) {
      const [err] = await run<never>(peer.disconnect)();
      if (err) {
        this._notify({
          type: 'disconnecting-failed',
          address,
          key,
          details: err,
        } as ListenEvent);
        throw err;
      }
    }

    this._peers.delete(address);
    this._notify({type: 'disconnected', address, key} as ListenEvent);

    // Re-connect because while disconnect() was running,
    // someone called connect()
    if (this._connectRetries.has(address)) {
      this._connectRetries.delete(address);
      this.connect(address);
    }

    return true;
  }

  public reset() {
    for (var id in this._server.peers) {
      if (id !== this._server.id) {
        for (let peer of this._server.peers[id]) {
          peer.close(true);
        }
      }
    }
  }

  public entries() {
    return this._peers.entries();
  }

  public getState(address: Address): Data['state'] | undefined {
    if (!msAddress.check(address)) {
      throw new Error('The given address is not a valid multiserver-address');
    }

    if (!this._peers.has(address)) return undefined;
    return this._peers.get(address)!.state;
  }

  // TODO add API trafficStats() to replace schedule::isCurrentlyDownloading()

  // TODO document all the possible types of events
  public listen() {
    return this._notify.listen();
  }
}

export = ConnHub;
