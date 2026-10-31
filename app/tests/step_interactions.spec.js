const assert = require("assert");

// Mock browser environment for state and step checkoff
const storage = {};
global.localStorage = {
  getItem: (k) => storage[k] || null,
  setItem: (k, v) => { storage[k] = String(v); },
  removeItem: (k) => { delete storage[k]; }
};

global.window = {
  localStorage: global.localStorage,
  SOLIN_DATA: { recipes: [], suggestedSubs: {} }
};

require("../state.js");

const S = global.window.SolinStore;

console.log("Testing SolinStore step checks...");
// 1. Initially empty
assert.deepStrictEqual(S.getStepChecks("r-test"), []);

// 2. Set checks
S.setStepChecks("r-test", [0, 2]);
assert.deepStrictEqual(S.getStepChecks("r-test"), [0, 2]);

// 3. Clear checks
S.setStepChecks("r-test", []);
assert.deepStrictEqual(S.getStepChecks("r-test"), []);

console.log("✓ SolinStore step checks passed");
