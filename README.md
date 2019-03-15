# ssb-conn-hub

Module that manages active connections to peers. For use with the SSB CONN family of modules.

## Usage

This module is only used to create an SSB CONN plugin, not used directly by applications.

```js
const ConnHub = require('ssb-conn-hub')

const connPlugin = {
  name: 'conn',
  version: '1.0.0',
  manifest: {
    add: 'sync'
  },
  init: function(server) {
    const connHub = new ConnHub(server);
    return {
      connect: function(address, data) {
        // NOTICE THIS
        connHub.connect(address).then(connected => {
          // ...
        });
      },
    };
  }
};
```

## API

* `new ConnHub(server)`: constructor for a connHub instance, accepting an `ssb-server` instance as argument
* `connHub.connect(address)`: connect to a peer known by its `address` (string, must conform to the [multiserver address convention](https://github.com/dominictarr/multiserver-address)). Returns a Promise, with the three possible outcomes:
  - Resolves with an RPC object that represents the successfully connected peer
  - Resolves with `false` when the connect was unnecessary, therefore not performed
  - Rejects with an error indicating why the connection failed
* `connHub.disconnect(address)`: disconnect from a peer known by its `address` (string, must conform to the multiserver address convention). Returns a Promise, with the three possible outcomes:
  - Resolves with `true` when disconnected successfully
  - Resolves with `false` when the disconnect was unnecessary, therefore not performed
  - Rejects with an error indicating why the disconnection failed
* `connHub.reset()`: closes all connections, basically resetting this instance as if it had just been started
* `connHub.entries()`: returns a new `Iterator` object that gives `[address, data]` pairs, where data has the state and key of the peer
* `connDB.listen()`: returns a pull stream that notifies of connection events, as an object `{type, address, key, details}` where:
  - `type` is either `'connecting'`, `'connecting-failed'`, `'connected'`, `'disconnecting'`, `'disconnecting-failed'`, `'disconnected'`
  - `address` is the original address used for connecting
  - (maybe present) `key` is the cryptographic public id
  - (maybe present) `details` is an object with additional info (such as errors)
* `connHub.getState(address)`: returns undefined if the peer for that address is disconnected, otherwise returns one of `'connecting'`, `'connected'`, or `'disconnecting'`

## License

MIT
