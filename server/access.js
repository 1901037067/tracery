/* 手机网页入口来自本机网卡与主应用端口；与仓库同步发现、配对端口无关。 */
import os from 'node:os';

export function phoneAccess(port, interfaces = os.networkInterfaces()) {
  const seen = new Set(), addresses = [];
  for (const [name, records] of Object.entries(interfaces)) {
    for (const record of records || []) {
      if (record.internal || !['IPv4', 4].includes(record.family) || seen.has(record.address)) continue;
      seen.add(record.address);
      const virtual = /virtual|vmware|vmnet|vbox|vethernet|hyper-v|wsl|docker|vpn|tailscale|zerotier|utun|\btun\d|\btap\d/i.test(name);
      addresses.push({ name, address: record.address, url: `http://${record.address}:${port}`, virtual });
    }
  }
  const priority = item => (item.virtual ? 10 : 0) + (/wi-?fi|wlan|wireless|ethernet|以太网|无线/i.test(item.name) ? 0 : 1);
  addresses.sort((a, b) => priority(a) - priority(b) || a.name.localeCompare(b.name));
  return { addresses, access: 'read-write', requiresComputer: true };
}
