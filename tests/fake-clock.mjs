// Loaded with `node --import` for suites written for a fixed date: this process's clock starts at FAKE_NOW and runs
// on from there, so "today" is the same whenever the suite runs.
const target = Date.parse(process.env.FAKE_NOW || '');
if (!Number.isNaN(target)) {
  const Real = Date, offset = target - Real.now();
  globalThis.Date = class extends Real {
    constructor(...a) { if (a.length) super(...a); else super(Real.now() + offset); }
    static now() { return Real.now() + offset; }
  };
}
