export interface IptablesChain {
  name: string;
  policy: string | null;
  rules: string[];
}

export interface IptablesTable {
  table: string;
  chains: IptablesChain[];
}

export function parseIptablesSave(output: string): IptablesTable {
  const lines = output.split('\n').filter((l) => l.trim().length > 0);
  let table = 'unknown';
  const chainMap = new Map<string, IptablesChain>();

  for (const line of lines) {
    if (line.startsWith('*')) {
      table = line.substring(1).trim();
    } else if (line.startsWith(':')) {
      // :CHAIN POLICY [packets:bytes]
      const match = line.match(/^:(\S+)\s+(\S+)/);
      if (match) {
        chainMap.set(match[1], {
          name: match[1],
          policy: match[2] === '-' ? null : match[2],
          rules: [],
        });
      }
    } else if (line.startsWith('-A ')) {
      // -A CHAIN ... rule
      const spaceIdx = line.indexOf(' ', 3);
      const chainName = spaceIdx > 0 ? line.substring(3, spaceIdx) : line.substring(3);
      const rule = spaceIdx > 0 ? line.substring(spaceIdx + 1) : '';

      let chain = chainMap.get(chainName);
      if (!chain) {
        chain = { name: chainName, policy: null, rules: [] };
        chainMap.set(chainName, chain);
      }
      chain.rules.push(rule);
    }
    // Ignore COMMIT and comments
  }

  return {
    table,
    chains: Array.from(chainMap.values()),
  };
}

export interface ConntrackEntry {
  protocol: string;
  protocolNumber: string;
  ttl: string;
  state: string | null;
  src: string | null;
  dst: string | null;
  sport: string | null;
  dport: string | null;
  replySrc: string | null;
  replyDst: string | null;
  replySport: string | null;
  replyDport: string | null;
  mark: string | null;
}

export function parseConntrack(output: string): ConntrackEntry[] {
  const lines = output.split('\n').filter((l) => l.trim().length > 0);
  const entries: ConntrackEntry[] = [];

  for (const line of lines) {
    // Skip header/summary lines
    if (line.startsWith('conntrack ')) continue;

    const fields = line.split(/\s+/);
    if (fields.length < 4) continue;

    const entry: ConntrackEntry = {
      protocol: fields[0],
      protocolNumber: fields[1],
      ttl: fields[2],
      state: null,
      src: null,
      dst: null,
      sport: null,
      dport: null,
      replySrc: null,
      replyDst: null,
      replySport: null,
      replyDport: null,
      mark: null,
    };

    // Check if field[3] is a state (e.g., ESTABLISHED, SYN_SENT) or a key=value
    if (!fields[3].includes('=')) {
      entry.state = fields[3];
    }

    // Parse key=value pairs. The second occurrence of src= marks the reply direction.
    let seenSrc = false;
    let inReply = false;
    for (const field of fields.slice(3)) {
      if (field.startsWith('[')) continue; // Skip [ASSURED], [UNREPLIED]

      const eqIdx = field.indexOf('=');
      if (eqIdx < 0) continue;
      const key = field.substring(0, eqIdx);
      const value = field.substring(eqIdx + 1);

      // Detect reply direction by second occurrence of src=
      if (key === 'src') {
        if (seenSrc) {
          inReply = true;
        }
        seenSrc = true;
      }

      if (inReply) {
        if (key === 'src') entry.replySrc = value;
        else if (key === 'dst') entry.replyDst = value;
        else if (key === 'sport') entry.replySport = value;
        else if (key === 'dport') entry.replyDport = value;
      } else {
        if (key === 'src') entry.src = value;
        else if (key === 'dst') entry.dst = value;
        else if (key === 'sport') entry.sport = value;
        else if (key === 'dport') entry.dport = value;
        else if (key === 'mark') entry.mark = value;
      }
    }

    entries.push(entry);
  }

  return entries;
}

export interface PingResult {
  host: string;
  transmitted: number;
  received: number;
  lossPercent: number;
  rttMin: number | null;
  rttAvg: number | null;
  rttMax: number | null;
}

export function parsePing(output: string): PingResult {
  const result: PingResult = {
    host: '',
    transmitted: 0,
    received: 0,
    lossPercent: 100,
    rttMin: null,
    rttAvg: null,
    rttMax: null,
  };

  // PING host (ip): data bytes
  const hostMatch = output.match(/PING\s+(\S+)/);
  if (hostMatch) {
    result.host = hostMatch[1];
  }

  // 3 packets transmitted, 3 packets received, 0% packet loss
  const statsMatch = output.match(/(\d+)\s+packets?\s+transmitted,\s+(\d+)\s+(?:packets?\s+)?received,\s+(\d+(?:\.\d+)?)%\s+packet\s+loss/);
  if (statsMatch) {
    result.transmitted = parseInt(statsMatch[1], 10);
    result.received = parseInt(statsMatch[2], 10);
    result.lossPercent = parseFloat(statsMatch[3]);
  }

  // rtt min/avg/max/mdev = 0.123/0.456/0.789/0.012 ms
  // or: round-trip min/avg/max/stddev = ...
  const rttMatch = output.match(/(?:rtt|round-trip)\s+min\/avg\/max\/\S+\s*=\s*([\d.]+)\/([\d.]+)\/([\d.]+)/);
  if (rttMatch) {
    result.rttMin = parseFloat(rttMatch[1]);
    result.rttAvg = parseFloat(rttMatch[2]);
    result.rttMax = parseFloat(rttMatch[3]);
  }

  return result;
}
