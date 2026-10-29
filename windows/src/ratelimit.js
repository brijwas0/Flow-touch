'use strict';

/** Simple token bucket. `take(n)` returns true if n tokens were available. */
class TokenBucket {
  constructor({ ratePerSec, burst, now = () => Date.now() }) {
    this.rate = ratePerSec;
    this.burst = burst;
    this.now = now;
    this.tokens = burst;
    this.last = now();
  }

  take(n = 1) {
    const t = this.now();
    const elapsed = Math.max(0, t - this.last) / 1000;
    this.last = t;
    this.tokens = Math.min(this.burst, this.tokens + elapsed * this.rate);
    if (this.tokens >= n) {
      this.tokens -= n;
      return true;
    }
    return false;
  }
}

module.exports = { TokenBucket };
