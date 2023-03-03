const EventEmitter = require('events');
const crypto = require('crypto');
const dgram = require('dgram');
const debug = require('debug')('mihome:miio');

const PORT = 54321;

class MiIOProtocol extends EventEmitter {

  constructor() {
    super();
    this._devices = new Map();

    this.timeout = 5000;
    this.retries = 2;
  }

  init() {
    this.createSocket();
  }

  destroy() {
    this.destroySocket();
  }

  createSocket() {
    this._socket = dgram.createSocket('udp4');

    // Bind the socket and when it is ready mark it for broadcasting
    // this._socket.bind();
    this._socket.on('listening', () => {
      // this._socket.setBroadcast(true);

      const address = this._socket.address();
      debug(`Server listening ${address.address}:${address.port}`);
    });

    // On any incoming message, parse it, update the discovery
    this._socket.on('message', (msg, rinfo) => {
      this._onMessage(rinfo.address, msg);
    });

    this._socket.on('error', error => {
      debug('Socket error', error);
    });
  }

  destroySocket() {
    if (this._socket) {
      this._socket.close();
    }
  }

  getDevices() {
    return Array.from(this._devices.keys()).map(address => {
      return {
        address,
        ...this.getDevice(address),
      };
    });
  }

  hasDevice(address) {
    return this._devices.has(address);
  }

  getDevice(address) {
    if (!this._devices.has(address)) {
      this._devices.set(address, {});
    }
    const device = this._devices.get(address);
    if (!device._lastId) {
      device._lastId = 0;
    }
    if (!device._promises) {
      device._promises = new Map();
    }
    return device;
  }

  setDevice(address, data) {
    const device = { ...data };
    if (device.token) {
      device._token = Buffer.from(device.token, 'hex');
      device._tokenKey = crypto.createHash('md5').update(device._token).digest();
      device._tokenIV = crypto
        .createHash('md5')
        .update(device._tokenKey)
        .update(device._token)
        .digest();
    }
    this._devices.set(address, device);
  }

  updateDevice(address, data) {
    const device = Object.assign(this.getDevice(address), data);
    this.setDevice(address, device);
  }

  _onMessage(address, msg) {
    try {
      const data = this._decryptMessage(address, msg);

      if (data === null) {
        // hanshake
        debug(`${address} -> Handshake reply`);
        this._onHandshake(address);
      } else {
        debug(`${address} -> Data`, data);
        this._onData(address, data);
      }
    } catch (e) {
      debug(`${address} -> Unable to parse packet`, e);
    }
  }

  _decryptMessage(address, msg) {
    const device = this.getDevice(address);

    const deviceId = msg.readUInt32BE(8);
    const stamp = msg.readUInt32BE(12);
    const checksum = msg.slice(16, 32);
    const encrypted = msg.slice(32);

    if (deviceId !== device.id) {
      device.id = deviceId;
    }

    if (stamp > 0) {
      device._serverStamp = stamp;
      device._serverStampTime = Date.now();
    }

    if (encrypted.length === 0) {
      // hanshake
      if (!checksum.toString('hex').match(/^[fF0]+$/)) {
        // const token = checksum;
      }

      return null;
    }

    if (!device._token) {
      throw new Error(`Missing token of device ${deviceId} - ${address}`);
    }

    const digest = crypto
      .createHash('md5')
      .update(msg.slice(0, 16))
      .update(device._token)
      .update(encrypted)
      .digest();

    if (!checksum.equals(digest)) {
      throw new Error(`Invalid packet, checksum was ${checksum} should be ${digest}`);
    }

    const decipher = crypto.createDecipheriv('aes-128-cbc', device._tokenKey, device._tokenIV);
    const data = Buffer.concat([
      decipher.update(encrypted),
      decipher.final()
    ]);

    return data;
  }

  _encryptMessage(address, data) {
    const device = this.getDevice(address);

    if (!device._token || !device.id) {
      throw new Error(`${address} <- Missing token or deviceId for send command`);
    }

    const header = Buffer.alloc(2 + 2 + 4 + 4 + 4 + 16);
    header.writeInt16BE(0x2131);

    // Encrypt the data
    const cipher = crypto.createCipheriv('aes-128-cbc', device._tokenKey, device._tokenIV);
    const encrypted = Buffer.concat([cipher.update(data), cipher.final()]);

    // Set the length
    header.writeUInt16BE(32 + encrypted.length, 2);

    // Unknown
    header.writeUInt32BE(0x00000000, 4);

    // Stamp
    if (device._serverStampTime) {
      const secondsPassed = Math.floor((Date.now() - device._serverStampTime) / 1000);
      header.writeUInt32BE(device._serverStamp + secondsPassed, 12);
    } else {
      header.writeUInt32BE(0xffffffff, 12);
    }

    // Device ID
    header.writeUInt32BE(Number(device.id), 8);

    // MD5 Checksum
    const digest = crypto
      .createHash('md5')
      .update(header.slice(0, 16))
      .update(device._token)
      .update(encrypted)
      .digest();
    digest.copy(header, 16);

    debug(`${address} <-`, header);
    return Buffer.concat([header, encrypted]);
  }

  _onHandshake(address) {
    const device = this.getDevice(address);
    if (device._handshakeResolve) {
      device._handshakeResolve();
    }
  }

  _onData(address, msg) {
    // Handle null-terminated strings
    if (msg[msg.length - 1] === 0) {
      msg = msg.slice(0, msg.length - 1);
    }

    // Parse and handle the JSON message
    let str = msg.toString('utf8');

    // Remove non-printable characters to help with invalid JSON from devices
    str = str.replace(/[\x00-\x09\x0B-\x0C\x0E-\x1F\x7F-\x9F]/g, ''); // eslint-disable-line

    debug(`${address} -> Message: ${str}`);
    try {
      const data = JSON.parse(str);
      const device = this.getDevice(address);
      const p = device._promises.get(data.id);
      if (!p) return;
      if (typeof data.result !== 'undefined') {
        p.resolve(data.result);
      } else {
        p.reject(data.error);
      }
    } catch (ex) {
      debug(`${address} -> Invalid JSON`, ex);
    }
  }

  _socketSend(msg, address, port = PORT) {
    return new Promise((resolve, reject) => {
      this._socket.send(msg, 0, msg.length, port, address, err => {
        if (err) {
          reject(err);
        } else {
          resolve();
        }
      });
    });
  }

  _handshake(address) {
    const msg = Buffer.from('21310020ffffffffffffffffffffffffffffffffffffffffffffffffffffffff', 'hex');
    return this._socketSend(msg, address);
  }

  _send(address, json) {
    const msg = this._encryptMessage(address, Buffer.from(JSON.stringify(json), 'utf8'));
    return this._socketSend(msg, address);
  }

  async handshake(address) {
    if (!address) {
      throw new Error('Missing address for handshake');
    }
    debug(`Start handshake ${address}`);
    const device = this.getDevice(address);

    const needsHandshake = !device.serverStampTime || (Date.now() - this._serverStampTime) > 120000;
    if (!needsHandshake) {
      return Promise.resolve();
    }

    // If a handshake is already in progress use it
    if (device._handshakePromise) {
      return device._handshakePromise;
    }

    device._handshakePromise = new Promise((resolve, reject) => {
      this._handshake(address).catch(reject);

      device._handshakeResolve = () => {
        // eslint-disable-next-line no-shadow
        clearTimeout(device._handshakeTimeout);
        device._handshakeResolve = null;
        device._handshakeTimeout = null;
        device._handshakePromise = null;

        resolve();
      };

      // Timeout for the handshake
      device._handshakeTimeout = setTimeout(() => {
        device._handshakeResolve = null;
        device._handshakeTimeout = null;
        device._handshakePromise = null;

        const err = new Error('Could not connect to device, handshake timeout');
        err.code = 'timeout';
        reject(err);
      }, this.timeout);
    });

    return device._handshakePromise;
  }

  async send(address, method, params = [], options = {}) {
    debug(`Call ${address}: ${method} - ${JSON.stringify(params)} - ${JSON.stringify(options)}`);
    const request = {
      method,
      params,
    };
    const device = this.getDevice(address);

    if (options && options.sid) {
      // If we have a sub-device set it (used by Lumi Smart Home Gateway)
      request.sid = options.sid;
    }

    return new Promise((resolve, reject) => {
      let resolved = false;

      // Handler for incoming messages
      const promise = {
        resolve: res => {
          resolved = true;
          device._promises.delete(request.id);

          resolve(res);
        },
        reject: err => {
          resolved = true;
          device._promises.delete(request.id);

          if (!(err instanceof Error) && typeof err.code !== 'undefined') {
            const { code, message } = err;
            err = new Error(message);
            err.code = code;
          }
          reject(err);
        },
      };

      let retriesLeft = options.retries >= 0 ? options.retries : this.retries;
      const retry = () => {
        if (resolved) return;
        if (retriesLeft-- > 0) {
          // eslint-disable-next-line no-use-before-define
          send();
        } else {
          debug(`${address} <- Reached maximum number of retries, giving up ${method} - ${JSON.stringify(params)}`);
          const err = new Error('Call to device timed out');
          err.code = 'timeout';
          promise.reject(err);
        }
      };

      const send = () => {
        this.handshake(address)
          .catch(err => {
            if (err.code === 'timeout') {
              debug(`${address} <- Handshake timed out`);
              retry();
              return false;
            }
            throw err;
          })
          .then(() => {
            // Assign the identifier before each send
            let id;
            if (request.id) {
              /*
              * This is a failure, increase the last id. Should
              * increase the chances of the new request to
              * succeed. Related to issues with the vacuum
              * not responding such as described in issue #94.
              */
              id = device._lastId + 100;

              // Make sure to remove the failed promise
              device._promises.delete(request.id);
            } else {
              id = device._lastId + 1;
            }

            // Check that the id hasn't rolled over
            if (id >= 10000) {
              id = 1;
            }
            device._lastId = id;

            // Assign the identifier
            request.id = id;

            // Store reference to the promise so reply can be received
            device._promises.set(id, promise);

            // Create the JSON and send it
            debug(`${address} <- (${retriesLeft}) ${JSON.stringify(request)}`);

            this._send(address, request).catch(promise.reject);

            // Queue a retry
            setTimeout(retry, this.timeout);
          })
          .catch(promise.reject);
      };

      send();
    });
  }

}

module.exports = new MiIOProtocol();
