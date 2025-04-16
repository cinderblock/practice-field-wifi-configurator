import SyslogServer from 'syslog-server';

// Fixed address for the Syslog server
const DefaultAddress = '10.0.100.40';

export async function startSyslogServer(address = DefaultAddress) {
  return new Promise<SyslogServer>(async (resolve, reject) => {
    const s = new SyslogServer();
    s.on('error', reject);
    await s.start({ address }, err => {
      if (err) {
        console.error('Failed to start Syslog server:', err);
        reject(err);
        return;
      }
      console.log(`Syslog server started on ${address}:514`);
    });

    resolve(s);
  });
}

export async function runSyslogServer() {
  return startSyslogServer().catch(err => {
    if ('code' in err && 'address' in err && err.code == 'EADDRNOTAVAIL') {
      console.log(`Bind to ${err.address} to enable Syslog server`);
      return;
    }
    console.log('Failed to start Syslog server:');
    console.log(err);
  });
}
