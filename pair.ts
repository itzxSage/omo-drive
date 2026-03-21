import qrcode from 'qrcode';
import { $ } from 'bun';

export async function getQRTerminal(url: string): Promise<string> {
  return await qrcode.toString(url, { type: 'terminal', small: true });
}

export async function getQRImage(url: string): Promise<Buffer> {
  return await qrcode.toBuffer(url, { type: 'png', width: 400, margin: 2 });
}

export async function getTailnetURL(): Promise<string> {
  try {
    const tailscalePath = '/Applications/Tailscale.app/Contents/MacOS/Tailscale';
    const output = await $`${tailscalePath} status --json`.text();
    const status = JSON.parse(output);
    let dnsName = status.Self.DNSName;
    if (dnsName.endsWith('.')) {
      dnsName = dnsName.slice(0, -1);
    }
    return `https://${dnsName}`;
  } catch (error) {
    throw new Error('Tailscale not available or error fetching status');
  }
}
