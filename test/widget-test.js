#!/usr/bin/env node
/*
 * Focused configuration checks for ergm-widget.js. A tiny DOM stand-in is
 * enough to exercise its option normalization and control construction in
 * Node without adding a test dependency.
 *
 * Run: node test/widget-test.js
 */
const assert = require("assert");

function Element(tagName) {
  this.tagName = tagName;
  this.children = [];
  this.style = {};
  this.className = "";
  this.textContent = "";
  this.innerHTML = "";
  this.classList = {
    add: (name) => {
      this.className = this.className ? this.className + " " + name : name;
    },
  };
}

Element.prototype.appendChild = function (child) {
  this.children.push(child);
  return child;
};
Element.prototype.addEventListener = function () {};
Element.prototype.setAttribute = function () {};
Element.prototype.closest = function () {
  return null;
};

global.document = {
  head: new Element("head"),
  createElement: function (tagName) {
    return new Element(tagName);
  },
};
global.ERGM = require("../src/ergm.js");
const ERGMWidget = require("../src/ergm-widget.js");

function mount(opts) {
  return ERGMWidget.mount(new Element("div"), Object.assign({ layout: "circle" }, opts));
}

function inputKeys(widget) {
  return Object.keys(widget._inputs);
}

function hasReciprocityHint(widget) {
  const controls = widget.el.children[1];
  return controls.children.some(function (child) {
    return child.className === "ergm-hint";
  });
}

console.log("ergm-widget.js configuration tests\n");

// The omitted option retains the original three-term model and all setup UI.
{
  const widget = mount({});
  assert.deepStrictEqual(widget.opts.model, ["edges", "nodematch", "mutual"]);
  assert.deepStrictEqual(inputKeys(widget), ["theta.edges", "theta.nodematch", "theta.mutual", "n", "meanDegree"]);
}

// Term slider order follows the caller's model order; inactive theta values
// are discarded even when supplied in the input object.
{
  const widget = mount({
    model: ["mutual", "edges"],
    theta: { edges: -1, nodematch: 99, mutual: 2 },
  });
  assert.deepStrictEqual(inputKeys(widget), ["theta.mutual", "theta.edges", "n", "meanDegree"]);
  assert.deepStrictEqual(widget.opts.theta, { mutual: 2, edges: -1 });
  assert.strictEqual("nodematch" in widget.opts.theta, false);
  assert.strictEqual(hasReciprocityHint(widget), true);
  assert.strictEqual(hasReciprocityHint(mount({ model: ["edges"] })), false);
}

// Repeated names are deduplicated in first-seen order.
{
  const widget = mount({ model: ["edges", "mutual", "edges"] });
  assert.deepStrictEqual(widget.opts.model, ["edges", "mutual"]);
  assert.deepStrictEqual(inputKeys(widget), ["theta.edges", "theta.mutual", "n", "meanDegree"]);
}

// A zero-term model has no theta controls and yields the logistic(0) update
// probability prescribed by a model with no sufficient statistics.
{
  const widget = mount({ model: [] });
  assert.deepStrictEqual(inputKeys(widget), ["n", "meanDegree"]);
  const randomValues = [0, 0, 0];
  const rec = ERGM.step(widget.net, widget.opts.theta, function () {
    return randomValues.shift();
  });
  assert.strictEqual(rec.p, 0.5);
}

// The two setup controls may be hidden independently.
{
  assert.strictEqual(inputKeys(mount({ controls: { n: false } })).indexOf("n"), -1);
  assert.notStrictEqual(inputKeys(mount({ controls: { n: false } })).indexOf("meanDegree"), -1);
  assert.strictEqual(inputKeys(mount({ controls: { meanDegree: false } })).indexOf("meanDegree"), -1);
  assert.notStrictEqual(inputKeys(mount({ controls: { meanDegree: false } })).indexOf("n"), -1);
}

// Invalid definitions fail before touching the target mount element.
{
  const target = new Element("div");
  target.innerHTML = "unchanged";
  assert.throws(function () {
    ERGMWidget.mount(target, { model: ["not-a-term"] });
  }, function (err) {
    return err instanceof RangeError && /Unknown ERGM term "not-a-term"/.test(err.message);
  });
  assert.strictEqual(target.innerHTML, "unchanged");
  assert.throws(function () {
    mount({ model: "edges" });
  }, TypeError);
  assert.throws(function () {
    mount({ model: ["edges", 3] });
  }, TypeError);
}

console.log("All checks passed.");
