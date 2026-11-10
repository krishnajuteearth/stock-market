// Market data providers. To add one: write a module with the same four methods as
// yahoo.js (search, quote, history, fundamentals) plus name/label/defaultDelayMinutes,
// register it here, and set MARKET_PROVIDER in .env. Read its API key from
// process.env inside the module so it never leaves the server.
import yahoo from './yahoo.js';

const providers = { yahoo };

export function getProvider(name = process.env.MARKET_PROVIDER || 'yahoo') {
  const provider = providers[name];
  if (!provider) throw new Error(`Unknown MARKET_PROVIDER "${name}". Available: ${Object.keys(providers).join(', ')}`);
  return provider;
}
