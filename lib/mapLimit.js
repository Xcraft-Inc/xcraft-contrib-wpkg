'use strict';

class MapLimit extends Map {
  constructor(max) {
    super();
    this._max = max;
  }

  set(key, value) {
    while (this.size >= this._max) {
      const it = this.entries();
      this.delete(it.next().value[0]);
    }
    super.set(key, value);
  }
}

module.exports = MapLimit;
