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
* `new ConnHub(server, opts)`: like the above, but the second argument is an optional object with configurations:
  - `opts.pingTimeout` (default 5 minutes): time interval between ping calls to other peers.
* `connHub.connect(address)`: connect to a peer known by its `address` (string, must conform to the [multiserver address convention](https://github.com/dominictarr/multiserver-address)). Returns a Promise, with the three possible outcomes:
  - Resolves with an RPC object that represents the successfully connected peer
  - Resolves with `false` when the connect was unnecessary, therefore not performed
  - Rejects with an error indicating why the connection failed
* `connHub.disconnect(address)`: disconnect from a peer known by its `address` (string, must conform to the multiserver address convention). Returns a Promise, with the three possible outcomes:
  - Resolves with `true` when disconnected successfully
  - Resolves with `false` when the disconnect was unnecessary, therefore not performed
  - Rejects with an error indicating why the disconnection failed

## License

MIT
