import {ConnectionData as Data, ListenEvent, Address} from './types';
import run = require('promisify-tuple');
import {EventEmitter} from 'events';
const pull = require('pull-stream');
const cat = require('pull-cat');
const Notify = require('pull-notify');
const ip = require('ip');
const msNetPlugin = require('multiserver/plugins/net')({});
const msAddress = require('multiserver-address');
const ref = require('ssb-ref');
const debug = require('debug')('ssb:conn-hub');

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

// TODO perhaps the `type` should be provided by each multiserver plugin?
// like when multiserver plugins provide the `stream.address` to secret-stack
function inferPeerType(address: Address): Data['inferredType'] {
  if (address.startsWith('bt:')) return 'bt';
  if (address.startsWith('dht:')) return 'dht';
  if (address.startsWith('tunnel:')) return 'tunnel';
  if (address.startsWith('net:')) {
    const netAddr = address.split('~')[0];
    const parsed = msNetPlugin.parse(netAddr);
    if (parsed && parsed.host) {
      if (ip.isPrivate(parsed.host)) return 'lan';
      else return 'internet';
    }
  }
  return;
}

class ConnHub {
  private readonly _server: any;
  private readonly _peers: Map<Address, Data>;
  private readonly _notifyEvent: any;
  private readonly _notifyEntries: any;
  private _closed: boolean;

  /**
   * Used only to schedule a connect when a disconnect is in progress.
   */
  private readonly _connectRetries: Set<Address>;

  constructor(server: any) {
    this._server = server;
    this._closed = false;
    this._connectRetries = new Set<Address>();
    this._peers = new Map<Address, Data>();
    this._notifyEvent = Notify();
    this._notifyEntries = Notify();
    this._init();
  }

  //#region PRIVATE

  private _init() {
    (this._server as EventEmitter).addListener(
      'rpc:connect',
      this._onRpcConnect,
    );
  }

  private _assertNotClosed() {
    if (this._closed) {
      throw new Error('This ConnHub instance is closed, create a new one.');
    }
  }

  private _assertValidAddress(address: Address) {
    if (!msAddress.check(address)) {
      throw new Error('The given address is not a valid multiserver-address');
    }
  }

  private _updateLiveEntries() {
    this._notifyEntries(Array.from(this._peers.entries()));
  }

  private _setPeer(address: Address, data: Partial<Data>) {
    const now = Date.now();
    const hubUpdated = now;
    const previousData = this._peers.get(address);
    if (previousData) {
      Object.keys(data).forEach(key => {
        const k = key as keyof Data;
        if (typeof data[k] === 'undefined') delete data[k];
      });
      this._peers.set(address, {...previousData, hubUpdated, ...data});
    } else if (!data.state) {
      debug('unexpected control flow, we cannot add a peer without state');
    } else {
      const hubBirth = now;
      this._peers.set(address, {hubBirth, hubUpdated, ...(data as Data)});
    }
  }

  private _getPeerByKey(key: string): [Address, Data] | undefined {
    for (let [address, data] of this._peers.entries()) {
      if (data.key === key) return [address, data];
    }
    return undefined;
  }

  // isClient means "we are the client"
  private _onRpcConnect = (rpc: any, isClient: boolean) => {
    // Don't process self connections, whatever that means:
    if (rpc.id === this._server.id) return;

    // If ssb-db is (available and) not ready, close this connection ASAP:
    if (this._server.ready && !this._server.ready()) return rpc.close();

    const peer = this._getPeerByKey(rpc.id);

    if (!peer && isClient) {
      // If peer was not registered through the public API, try again a few times
      // in case there was a race condition with ConnHub::connect()
      rpc._connectRetries = rpc._connectRetries || 0;
      if (isClient && rpc._connectRetries < 4) {
        setTimeout(() => {
          this._onRpcConnect(rpc, isClient);
        }, 200);
        rpc._connectRetries += 1;
      } else if (isClient) {
        debug(
          'our secret-stack initiated an RPC connection with %s but not ' +
            'through the ssb-conn-hub connect() API',
          rpc.id,
        );
      }
      return;
    }

    if (!peer) {
      // Here, weAreClient is surely `false`
      debug('peer %s initiated an RPC connection with us', rpc.id);
    }

    const [address, data] = !peer
      ? [rpc.stream.address, {key: rpc.id} as Data]
      : peer;
    if (!data.type) {
      data.inferredType = inferPeerType(address);
    }
    const key = data.key;

    const state = 'connected';
    const disconnect: Data['disconnect'] = cb => rpc.close(true, cb);
    this._setPeer(address, {...data, state, disconnect});
    debug('connected to %s', address);
    this._notifyEvent({
      type: state,
      address,
      key,
      details: {rpc, isClient},
    } as ListenEvent);
    this._updateLiveEntries();

    rpc.on('closed', () => {
      this._peers.delete(address);
      debug('disconnected from %s', address);
      this._notifyEvent({type: 'disconnected', address, key} as ListenEvent);
      this._updateLiveEntries();
    });
  };

  //#endregion

  //#region PUBLIC API

  public async connect(
    address: Address,
    data?: Partial<Data>,
  ): Promise<false | object> {
    this._assertNotClosed();
    this._assertValidAddress(address);

    if (this._peers.has(address)) {
      const peer = this._peers.get(address)!;
      if (peer.state === 'connecting' || peer.state === 'connected') {
        return false;
      } else if (peer.state === 'disconnecting') {
        // If disconnecting, schedule a connect() after disconnection completed
        this._connectRetries.add(address);
        return false;
      } else {
        debug('unexpected control flow, peer %o has bad state', peer);
      }
    }

    const state: Data['state'] = 'connecting';
    const key = inferPublicKey(address);
    if (data) {
      this._setPeer(address, {...data, state, key});
    } else {
      this._setPeer(address, {state, key});
    }
    debug('connecting to %s', address);
    this._notifyEvent({type: state, address, key} as ListenEvent);
    this._updateLiveEntries();

    const [err, rpc] = await run<any>(this._server.connect)(address);
    if (err) {
      this._peers.delete(address);
      debug('failed to connect to %s', address);
      this._notifyEvent({
        type: 'connecting-failed',
        address,
        key,
        details: err,
      } as ListenEvent);
      this._updateLiveEntries();
      throw err;
    }

    const peer = this._peers.get(address);
    if (!peer || peer.state !== 'connected') {
      const state: Data['state'] = 'connected';
      this._setPeer(address, {state, key});
      debug('connected to %s', address);
      this._notifyEvent({
        type: state,
        address,
        key,
        details: {rpc},
      } as ListenEvent);
      this._updateLiveEntries();
    }
    return rpc;
  }

  public async disconnect(address: Address): Promise<boolean> {
    this._assertNotClosed();
    this._assertValidAddress(address);

    if (!this._peers.has(address)) return false;

    const peer = this._peers.get(address)!;

    const key = inferPublicKey(address);
    const prevState = peer.state;
    if (prevState !== 'disconnecting') {
      const state: Data['state'] = 'disconnecting';
      this._setPeer(address, {state, key});
      debug('disconnecting from %s', address);
      this._notifyEvent({type: state, address, key} as ListenEvent);
      this._updateLiveEntries();
    }

    if (peer.disconnect) {
      const [err] = await run<never>(peer.disconnect)();
      if (err) {
        debug('failed to disconnect from %s', address);
        this._notifyEvent({
          type: 'disconnecting-failed',
          address,
          key,
          details: err,
        } as ListenEvent);
        this._setPeer(address, {state: prevState, key});
        this._updateLiveEntries();
        throw err;
      }
    }

    this._peers.delete(address);
    debug('disconnected from %s', address);
    this._notifyEvent({type: 'disconnected', address, key} as ListenEvent);
    this._updateLiveEntries();

    // Re-connect because while disconnect() was running,
    // someone called connect()
    if (this._connectRetries.has(address)) {
      this._connectRetries.delete(address);
      this.connect(address);
    }

    return true;
  }

  public update(address: Address, data: Partial<Data>): boolean {
    this._assertNotClosed();
    this._assertValidAddress(address);

    if (this._peers.has(address)) {
      this._setPeer(address, data);
      this._updateLiveEntries();
      return true;
    } else {
      return false;
    }
  }

  public reset() {
    this._assertNotClosed();

    for (var id in this._server.peers) {
      if (id !== this._server.id) {
        for (let peer of this._server.peers[id]) {
          peer.close(true);
        }
      }
    }
  }

  public entries() {
    this._assertNotClosed();

    return this._peers.entries();
  }

  public liveEntries() {
    this._assertNotClosed();

    return cat([
      pull.values([Array.from(this._peers.entries())]),
      this._notifyEntries.listen(),
    ]);
  }

  public getState(address: Address): Data['state'] | undefined {
    this._assertNotClosed();
    this._assertValidAddress(address);

    if (!this._peers.has(address)) return undefined;
    return this._peers.get(address)!.state;
  }

  // TODO add API trafficStats() to replace schedule::isCurrentlyDownloading()

  public listen() {
    this._assertNotClosed();

    return this._notifyEvent.listen();
  }

  public close() {
    (this._server as EventEmitter).removeListener(
      'rpc:connect',
      this._onRpcConnect,
    );
    this._closed = true;
    this._peers.clear();
    this._notifyEvent.end();
    this._notifyEntries.end();
    debug('closed the ConnHub instance');
  }

  //#endregion
}

export = ConnHub;
