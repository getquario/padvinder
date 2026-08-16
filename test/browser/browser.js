import { find, query } from "/lib/index.js";

const result = document.querySelector("#result");
const violations = [];

document.addEventListener("securitypolicyviolation", (event) => {
  violations.push(`${event.violatedDirective}: ${event.blockedURI}`);
});

const assert = (value, message) => {
  if (!value) throw Error(message);
};

try {
  const data = {
    store: {
      book: [
        { title: "Sayings", price: 8.95 },
        { title: "Sword", price: 12.99 },
        { title: "Moby", price: 8.99 },
      ],
    },
  };
  assert(
    JSON.stringify(find("$.store.book[0,2].title", data)) === '["Sayings","Moby"]',
    "union selector failed",
  );
  assert(
    JSON.stringify(find("$..book[?@.price < 10].title", data)) === '["Sayings","Moby"]',
    "filter selector failed",
  );

  globalThis.__padvinderInjected = false;
  const attacks = [
    "$[?@.ok || (globalThis.__padvinderInjected = true)]",
    '$[?@.x.constructor.constructor("globalThis.__padvinderInjected=true")()]',
    "$[?@.x]; globalThis.__padvinderInjected = true; $[?@.x]",
  ];
  for (const path of attacks) {
    let rejected = false;
    try {
      query(path);
    } catch (error) {
      rejected = error instanceof SyntaxError;
    }
    assert(rejected, `crafted filter was not rejected: ${path}`);
    assert(globalThis.__padvinderInjected === false, `crafted filter ran code: ${path}`);
  }

  assert(
    find(`$["x'); globalThis.__padvinderInjected=true; //"]`, {})[0] === undefined,
    "crafted name matched",
  );
  assert(globalThis.__padvinderInjected === false, "crafted query text ran code");

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert(violations.length === 0, `CSP violation: ${violations.join(", ")}`);
  result.dataset.status = "passed";
  result.textContent = "passed";
} catch (error) {
  result.dataset.status = "failed";
  result.textContent = error.stack || String(error);
}
