import fs from 'fs';
import NodeCache from 'node-cache';
import winston from 'winston';

const CACHE_FILE = './cache-data.json';

class PersistentCache {
    constructor(options = {}, logger) {
        this.cache = new NodeCache(options);
        this.logger = logger;
        this.loadFromDisk();

        // Save cache to disk every 5 minutes
        setInterval(() => this.saveToDisk(), 5 * 60 * 1000);
    }

    set(key, value, ttl = undefined) {
        const result = this.cache.set(key, value, ttl);
        this.saveToDisk();
        return result;
    }

    get(key) {
        return this.cache.get(key);
    }

    del(key) {
        const result = this.cache.del(key);
        this.saveToDisk();
        return result;
    }

    saveToDisk() {
        try {
            const data = {};
            const keys = this.cache.keys();
            keys.forEach(key => {
                const value = this.cache.get(key);
                if (value !== undefined) {
                    data[key] = {
                        value,
                        ttl: this.cache.getTtl(key)
                    };
                }
            });

            fs.writeFileSync(CACHE_FILE, JSON.stringify(data), 'utf8');
            this.logger.info('Cache saved to disk successfully');
        } catch (error) {
            this.logger.error(`Error saving cache to disk: ${error.message}`);
        }
    }

    loadFromDisk() {
        try {
            if (fs.existsSync(CACHE_FILE)) {
                const data = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
                const now = Date.now();

                Object.entries(data).forEach(([key, entry]) => {
                    if (entry.ttl && entry.ttl > now) {
                        // Only restore if TTL hasn't expired
                        const remainingTtl = Math.ceil((entry.ttl - now) / 1000);
                        this.cache.set(key, entry.value, remainingTtl);
                    }
                });
                this.logger.info('Cache loaded from disk successfully');
            }
        } catch (error) {
            this.logger.error(`Error loading cache from disk: ${error.message}`);
        }
    }
}

export default PersistentCache;

