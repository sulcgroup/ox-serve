# ox-serve
Backend for driving oxDNA simulations from oxView. 
*repo is in very active development* 

---
## [Introduction into ox-serve.](https://www.youtube.com/watch?v=FtU-Sr3aLdI)

---
## Installation 
* Install [nodejs](https://nodejs.org/en/)
* Clone the repository to your desired machine. 
* Switch to the installation folder and execute `npm install`
* Adjust settings as needed in `resources/config.json`
* Compile TypeScript with `npx tsc`
* Run the server by executing `node main.js`

## Running with TLS certificates
By default, ox-serve starts an HTTP server:

```sh
node main.js
```

To start HTTPS, provide both certificate and private key files as command line arguments:

```sh
node main.js --cert /path/to/cert.pem --key /path/to/key.pem
```

The equivalent long option names are also supported:

```sh
node main.js --cert-file /path/to/cert.pem --key-file /path/to/key.pem
```

If your setup needs a certificate authority bundle, pass it with `--ca` or `--ca-file`:

```sh
node main.js --cert /path/to/cert.pem --key /path/to/key.pem --ca /path/to/ca.pem
```

--- 
## [Using ox-serve with google colab](https://colab.research.google.com/drive/1nFC9zy-wEwwl8vlJZAbQZZofavP4PXvL#scrollTo=C_8TB2t5gxDg) 
