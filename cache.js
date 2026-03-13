// utils/cache.js
// Smart caching with different TTLs based on data type
// Live scores refresh faster than standings or rosters

const NodeCache = require("node-cache");

// Different caches for different data freshness needs
const caches = {
  live: new NodeCache({ stdTTL: 20 }),        // Scoreboards: 20 seconds
  standings: new NodeCache({ stdTTL: 300 }),   // Standings: 5 minutes
  roster: new NodeCache({ stdTTL: 3600 }),     // Rosters: 1 hour
  stats: new NodeCache({ stdTTL: 120 }),       // Player stats: 2 minutes
  teams: new NodeCache({ stdTTL: 86400 }),     // Teams list: 24 hours
  game: new NodeCache({ stdTTL: 30 }),         // Game detail: 30 seconds
};

/**
 * Get a cached value or fetch fresh data
 * @param {string} type - cache tier ("live" | "standings" | "roster" | "stats" | "teams" | "game")
 * @param {string} key - unique cache key
 * @param {Function} fetchFn - async function to call on cache miss
 */
async function getOrFetch(type, key, fetchFn) {
  const cache = caches[type];
  if (!cache) throw new Error(`Unknown cache type: ${type}`);

  const cached = cache.get(key);
  if (cached !== undefined) {
    return { data: cached, fromCache: true };
  }

  const fresh = await fetchFn();
  cache.set(key, fresh);
  return { data: fresh, fromCache: false };
}

/**
 * Manually invalidate a cache entry (useful for forced refreshes)
 */
function invalidate(type, key) {
  const cache = caches[type];
  if (cache) cache.del(key);
}

/**
 * Get cache stats for the health endpoint
 */
function getCacheStats() {
  return Object.entries(caches).reduce((acc, [name, cache]) => {
    const stats = cache.getStats();
    acc[name] = {
      keys: cache.keys().length,
      hits: stats.hits,
      misses: stats.misses,
    };
    return acc;
  }, {});
}

module.exports = { getOrFetch, invalidate, getCacheStats };
