#!/usr/bin/env node
/*
 * Compatibility checks for Net.attrs and ERGM.createModel().
 *
 * Run: node test/model-test.js
 */
const assert = require("assert");
const ERGM = require("../src/ergm.js");

function sequence(values) {
  let idx = 0;
  return function () {
    return values[idx++];
  };
}

function sameAdj(a, b) {
  assert.deepStrictEqual(Array.from(a.adj), Array.from(b.adj));
}

console.log("ergm.js model foundation tests\n");

// Legacy `attr` remains the first attribute and can be replaced in place.
{
  const attr = new Uint8Array([0, 1, 0]);
  const net = new ERGM.Net(3, { attr: attr });
  assert.strictEqual(net.attr, attr);
  assert.strictEqual(net.attrs.length, 1);
  assert.strictEqual(net.attrs[0], attr);

  const replacement = [2, 3, 4];
  net.attr = replacement;
  assert.strictEqual(net.attr, replacement);
  assert.strictEqual(net.attrs[0], replacement);
}

// Multiple numeric attributes clone deeply while retaining vector types.
{
  const net = new ERGM.Net(3, {
    attrs: [new Uint8Array([0, 1, 0]), [1.5, 2.5, 3.5]],
  });
  net.set(0, 1, true);
  const clone = net.clone();

  assert.notStrictEqual(clone.adj, net.adj);
  assert.notStrictEqual(clone.attrs, net.attrs);
  assert.notStrictEqual(clone.attrs[0], net.attrs[0]);
  assert.notStrictEqual(clone.attrs[1], net.attrs[1]);
  assert.ok(clone.attrs[0] instanceof Uint8Array);
  assert.deepStrictEqual(Array.from(clone.attrs[0]), [0, 1, 0]);
  assert.deepStrictEqual(clone.attrs[1], [1.5, 2.5, 3.5]);
  sameAdj(net, clone);

  clone.attrs[0][0] = 1;
  clone.attrs[1][0] = 99;
  clone.set(0, 1, false);
  assert.strictEqual(net.attrs[0][0], 0);
  assert.strictEqual(net.attrs[1][0], 1.5);
  assert.strictEqual(net.has(0, 1), true);
}

// Invalid attribute configurations fail at construction/assignment time.
{
  assert.throws(() => new ERGM.Net(2, { attr: [0] }), /length 2/);
  assert.throws(() => new ERGM.Net(2, { attr: [0, Infinity] }), /finite numbers/);
  assert.throws(() => new ERGM.Net(2, { attrs: [] }), /non-empty array/);
  assert.throws(() => new ERGM.Net(2, { attrs: [[0, 1]], attr: [0, 1] }), /mutually exclusive/);
  const net = new ERGM.Net(2);
  assert.throws(() => {
    net.attr = [0, NaN];
  }, /finite numbers/);
}

// A compiled version of the legacy model produces the same trajectory.
{
  const compiled = ERGM.createModel(["edges", "nodematch", "mutual"]);
  const base = new ERGM.Net(4, { attr: new Uint8Array([0, 0, 1, 1]) });
  base.set(1, 0, true);
  base.set(2, 3, true);
  const legacyNet = base.clone();
  const compiledNet = base.clone();
  const legacyRng = ERGM.makeRNG(123);
  const compiledRng = ERGM.makeRNG(123);
  const theta = [-1.2, 0.7, 1.1];

  ERGM.simulate(legacyNet, theta, 1000, legacyRng);
  compiled.simulate(compiledNet, theta, 1000, compiledRng);
  sameAdj(legacyNet, compiledNet);
}

// The documented TERMS + TERM_ORDER extension mechanism remains live rather
// than being captured when this module is first loaded.
{
  ERGM.TERMS.constantTwo = {
    stat: function () {
      return 0;
    },
    delta: function () {
      return 2;
    },
  };
  ERGM.TERM_ORDER.push("constantTwo");
  try {
    const net = new ERGM.Net(2);
    const rec = ERGM.step(net, { constantTwo: 0.5 }, sequence([0, 0, 0.5]));
    assert.ok(Math.abs(rec.p - 1 / (1 + Math.exp(-1))) < 1e-12);
    assert.strictEqual(net.statistics().constantTwo, 0);
  } finally {
    ERGM.TERM_ORDER.pop();
    delete ERGM.TERMS.constantTwo;
  }
}

// Descriptor IDs drive object theta lookup and statistic keys; arrays retain
// model-order semantics.
{
  const model = ERGM.createModel([
    { term: "edges", id: "arcCount" },
    { term: "mutual", id: "reciprocity" },
  ]);
  const objectNet = new ERGM.Net(3);
  objectNet.set(1, 0, true);
  const arrayNet = objectNet.clone();
  const objectRec = model.step(
    objectNet,
    { arcCount: -1, reciprocity: 2 },
    sequence([0, 0, 0.5])
  );
  const arrayRec = model.step(arrayNet, [-1, 2], sequence([0, 0, 0.5]));

  assert.strictEqual(objectRec.i, 0);
  assert.strictEqual(objectRec.j, 1);
  assert.ok(Math.abs(objectRec.p - 1 / (1 + Math.exp(-1))) < 1e-12);
  assert.deepStrictEqual(objectRec, arrayRec);
  sameAdj(objectNet, arrayNet);
  assert.deepStrictEqual(model.statistics(objectNet), { arcCount: 2, reciprocity: 1 });
  assert.deepStrictEqual(objectNet.statistics(model), { arcCount: 2, reciprocity: 1 });
}

// Parameterized factories can validate descriptors and networks without any
// compiler changes. This temporary factory exercises the extension point used
// by subsequent implementation issues.
{
  ERGM.TERM_FACTORIES.scaledEdges = function (spec) {
    const keys = Object.keys(spec);
    keys.forEach(function (key) {
      if (key !== "term" && key !== "id" && key !== "scale") {
        throw new RangeError("Unexpected scaledEdges parameter `" + key + "`.");
      }
    });
    if (typeof spec.scale !== "number" || !Number.isFinite(spec.scale)) {
      throw new TypeError("scaledEdges `scale` must be finite.");
    }
    return {
      stat: function (net) {
        return spec.scale * ERGM.TERMS.edges.stat(net);
      },
      delta: function () {
        return spec.scale;
      },
      validate: function (net) {
        if (net.n < 2) throw new RangeError("scaledEdges requires at least two nodes.");
      },
    };
  };

  try {
    const model = ERGM.createModel([{ term: "scaledEdges", id: "doubleEdges", scale: 2 }]);
    const net = new ERGM.Net(2);
    net.set(0, 1, true);
    assert.deepStrictEqual(model.statistics(net), { doubleEdges: 2 });
    assert.strictEqual(model.terms[0].spec.scale, 2);
    assert.throws(
      () => ERGM.createModel([{ term: "scaledEdges", id: "bad", scale: Infinity }]),
      /must be finite/
    );
    assert.throws(() => model.validate(new ERGM.Net(1)), /at least two nodes/);
  } finally {
    delete ERGM.TERM_FACTORIES.scaledEdges;
  }
}

// Model definition failures are detected before sampling.
{
  assert.throws(() => ERGM.createModel("edges"), /requires an array/);
  assert.throws(() => ERGM.createModel(["missing"]), /Unknown ERGM term/);
  assert.throws(() => ERGM.createModel([{ term: "edges" }]), /non-empty string `id`/);
  assert.throws(
    () => ERGM.createModel(["edges", { term: "mutual", id: "edges" }]),
    /Duplicate ERGM model id/
  );
  assert.throws(
    () => ERGM.createModel([{ term: "edges", id: "e", degree: 2 }]),
    /does not accept parameter/
  );
  assert.throws(
    () => ERGM.createModel([{ term: "edges", id: "__proto__" }]),
    /reserved id/
  );
}

// A zero-term compiled model has the expected logistic(0) update probability.
{
  const model = ERGM.createModel([]);
  const net = new ERGM.Net(2);
  const rec = model.step(net, {}, sequence([0, 0, 0.25]));
  assert.strictEqual(rec.p, 0.5);
  assert.deepStrictEqual(model.statistics(net), {});
}

console.log("All checks passed.");
