const Device = require('../device-miio');

module.exports = class extends Device {

  static model = 'chuangmi.camera.ipc019';
  static name = 'Xiaomi Chuangmi camera';
  static image = 'https://cdn.cnbj1.fds.api.mi-img.com/iotweb-product-center/developer_1578644370325XkfNikJ4.png?GalaxyAccessKeyId=AKVGLQWBOVIRQ3XLEW&Expires=9223372036854775807&Signature=1INeFNGZq9V4wV/iRyCcRD7cXqo=';

  constructor(opts) {
    super(opts);

    //this._miotSpecType = 'urn:miot-spec-v2:device:camera:0000A01C:chuangmi-ipc019:1';
    this._propertiesToMonitor = [
      'camera-control:on'
    ];
  }

  getPower() {
    return this.properties['camera-control:on'];
  }

  setPower(v) {
    return this.miotSetProperty('camera-control:on', v);
  }

};
