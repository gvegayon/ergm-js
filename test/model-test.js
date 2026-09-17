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

function networkFromMask(n, attr, mask) {
  const net = new ERGM.Net(n, { attr: attr });
  let bit = 0;
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i !== j) net.set(i, j, (mask >>> bit++) & 1);
    }
  }
  return net;
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

// Attribute factories use the requested attribute vector and their IDs are
// independent theta/statistic keys. The fixture is recorded in the frozen
// term contract: x = [1, 3, 6], ties 0->1 and 2->1.
{
  const net = new ERGM.Net(3, {
    attrs: [[0, 0, 1], [1, 3, 6]],
  });
  net.set(0, 1, true);
  net.set(2, 1, true);
  const model = ERGM.createModel([
    { term: "absdiff", id: "distance", attr: 1 },
    { term: "diff", id: "tailMinusHead", attr: 1, alpha: 1, tailHead: true },
    { term: "diff", id: "headMinusTail", attr: 1, alpha: 1, tailHead: false },
    { term: "nodeicov", id: "receiver", attr: 1 },
    { term: "nodeocov", id: "sender", attr: 1 },
    { term: "nodecov", id: "endpointSum", attr: 1 },
    { term: "nodematch", id: "numericMatch", attr: 1 },
    { term: "nodematch", id: "groupMatch", attr: 0 },
  ]);

  assert.deepStrictEqual(model.statistics(net), {
    distance: 5,
    tailMinusHead: 1,
    headMinusTail: -1,
    receiver: 6,
    sender: 7,
    endpointSum: 13,
    numericMatch: 0,
    groupMatch: 1,
  });
  assert.strictEqual(net.statistics().nodematch, 1);

  const rec = model.step(
    net.clone(),
    { receiver: 0.5, sender: 0.25 },
    sequence([0, 0, 0.5])
  );
  assert.ok(Math.abs(rec.p - 1 / (1 + Math.exp(-1.75))) < 1e-12);
}

// A change statistic is the value of a candidate attribute tie, regardless
// of whether that tie is currently present. Exhaust every three-node graph
// and both states of every candidate dyad.
{
  const attr = [1, 3, 6];
  const model = ERGM.createModel([
    { term: "absdiff", id: "abs", alpha: 2 },
    { term: "diff", id: "diffForward", alpha: 3, tailHead: true },
    { term: "diff", id: "diffReverse", alpha: 2, tailHead: false },
    { term: "nodeicov", id: "inCov" },
    { term: "nodeocov", id: "outCov" },
    { term: "nodecov", id: "cov" },
    { term: "nodematch", id: "match" },
  ]);

  for (let mask = 0; mask < 64; mask++) {
    const net = networkFromMask(3, attr, mask);
    for (let i = 0; i < 3; i++) {
      for (let j = 0; j < 3; j++) {
        if (i === j) continue;
        const off = net.clone();
        const on = net.clone();
        off.set(i, j, false);
        on.set(i, j, true);
        for (let k = 0; k < model.terms.length; k++) {
          const term = model.terms[k];
          assert.strictEqual(
            term.delta(net, i, j),
            term.stat(on) - term.stat(off),
            term.id + " must satisfy stat/delta identity for mask " + mask + ", " + i + "->" + j
          );
        }
      }
    }
  }
}

// Descriptor and runtime validation protect attribute factories from invalid
// selectors, exponents, direction flags, and mutated network vectors.
{
  assert.throws(
    () => ERGM.createModel([{ term: "nodecov", id: "bad", attr: -1 }]),
    /`attr` must be a non-negative integer/
  );
  assert.throws(
    () => ERGM.createModel([{ term: "nodecov", id: "bad", attr: 0.5 }]),
    /`attr` must be a non-negative integer/
  );
  assert.throws(
    () => ERGM.createModel([{ term: "absdiff", id: "bad", alpha: 0 }]),
    /`alpha` must be a positive finite number/
  );
  assert.throws(
    () => ERGM.createModel([{ term: "absdiff", id: "bad", alpha: Infinity }]),
    /`alpha` must be a positive finite number/
  );
  assert.throws(
    () => ERGM.createModel([{ term: "diff", id: "bad", alpha: 0.5 }]),
    /`alpha` must be a positive integer/
  );
  assert.throws(
    () => ERGM.createModel([{ term: "diff", id: "bad", tailHead: 1 }]),
    /`tailHead` must be a boolean/
  );
  assert.throws(
    () => ERGM.createModel([{ term: "nodeicov", id: "bad", attr: 0, alpha: 1 }]),
    /does not accept parameter/
  );

  const missingAttr = ERGM.createModel([{ term: "nodeocov", id: "unavailable", attr: 1 }]);
  assert.throws(() => missingAttr.statistics(new ERGM.Net(2)), /out of range/);

  const malformedVector = new ERGM.Net(2, { attr: [1, 2] });
  malformedVector.attrs[0] = [1, NaN];
  const model = ERGM.createModel([{ term: "nodeocov", id: "sender" }]);
  assert.throws(() => model.statistics(malformedVector), /finite numbers/);

  const overflow = new ERGM.Net(2, { attr: [Number.MAX_VALUE, -Number.MAX_VALUE] });
  const overflowModel = ERGM.createModel([{ term: "diff", id: "difference", alpha: 1 }]);
  assert.throws(() => overflowModel.step(overflow, {}, ERGM.makeRNG(1)), /non-finite attribute contribution/);

  const sumOverflow = new ERGM.Net(2, { attr: [Number.MAX_VALUE / 2, Number.MAX_VALUE / 2] });
  sumOverflow.set(0, 1, true);
  sumOverflow.set(1, 0, true);
  const sumOverflowModel = ERGM.createModel([{ term: "nodecov", id: "endpoints" }]);
  assert.throws(() => sumOverflowModel.statistics(sumOverflow), /non-finite attribute contribution/);
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
