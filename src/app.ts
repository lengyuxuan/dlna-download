import Dlna from './dlna';

(async () => {
    const dlna = new Dlna();
    // await dlna.startService('http://192.168.10.106:3000/test.xml');
    const list = await dlna.search(3, 10);
    for (const item of list) {
        console.log(item.device.friendlyName);
    }
})()
