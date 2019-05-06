const express = require("express");
const request = require("supertest");
const esm = require("../src/esm-middleware.js");
const createMockFs = require("../scripts/mock-fs.js");

test("sets correct content-type", async () => {
  const response = await request(
    express().use(
      esm({
        fs: createMockFs().addFiles(
          {
            path: "/client/app.js",
            content: "import { createStore } from 'redux';"
          },
          {
            path: "/node_modules/redux/package.json",
            content: JSON.stringify({ module: "es/index.js" })
          }
        )
      })
    )
  ).get("/client/app.js");
  expect(response.status).toBe(200);
  expect(response.header["content-type"]).toBe(
    "application/javascript; charset=utf-8"
  );
});

test("supports `module` key in package.json", async () => {
  const response = await request(
    express().use(
      esm({
        fs: createMockFs().addFiles(
          {
            path: "/client/app.js",
            content: 'import foo from "foo";'
          },
          {
            path: "/node_modules/foo/package.json",
            content: JSON.stringify({ module: "es/index.js" })
          }
        )
      })
    )
  ).get("/client/app.js");
  expect(response.status).toEqual(200);
  expect(response.text).toMatchSnapshot();
});

test("supports `jsnext:main` key in package.json", async () => {
  const response = await request(
    express().use(
      esm({
        fs: createMockFs().addFiles(
          {
            path: "/client/app.js",
            content: 'import foo from "foo";'
          },
          {
            path: "/node_modules/foo/package.json",
            content: JSON.stringify({ "jsnext:main": "es/index.js" })
          }
        )
      })
    )
  ).get("/client/app.js");
  expect(response.status).toEqual(200);
  expect(response.text).toMatchSnapshot();
});

test("caches modules by default", async () => {
  const fs = createMockFs().addFiles(
    {
      path: "/client/app.js",
      content: 'import foo from "foo";'
    },
    {
      path: "/node_modules/foo/package.json",
      content: JSON.stringify({ "jsnext:main": "es/index.js" })
    }
  );
  const app = express().use(esm({ fs }));
  await request(app).get("/client/app.js");

  fs.addFiles(
    {
      path: "/client/app.js",
      content: 'import bar from "bar";'
    },
    {
      path: "/node_modules/bar/package.json",
      content: JSON.stringify({ "jsnext:main": "es/index.js" })
    }
  );

  const response = await request(app).get("/client/app.js");
  expect(response.status).toEqual(200);
  expect(response.text).toMatchSnapshot();
});

test("delegates next middleware on unresolved module", async () => {
  const app = express().use(esm({ fs: createMockFs() }));
  const response = await request(app).get("/client/app.js");
  expect(response.status).toEqual(404);
});

test("supports commonjs modules", async () => {
  const fs = createMockFs().addFiles(
    {
      path: "client/app.js",
      content: 'import foo from "foo";'
    },
    {
      path: "/node_modules/foo/package.json",
      content: JSON.stringify({ main: "dist/index.js" })
    },
    {
      path: "/node_modules/foo/dist/index.js",
      content:
        "!function(e, t){t(exports)}(this, function(e){e.foo = 'bar'});const x = 1;"
    }
  );
  const app = express().use(esm({ fs }));
  const response1 = await request(app).get("/client/app.js");
  expect(response1.status).toEqual(200);
  expect(response1.text).toMatchSnapshot();

  const response2 = await request(app).get("/node_modules/foo/dist/index.js");
  expect(response2.status).toEqual(200);
  expect(response2.text).toMatchSnapshot();
});

test("supports fine-grained import from package", async () => {
  const fs = createMockFs().addFiles(
    {
      path: "/client/app.js",
      content: 'import foo from "@foo/foo.js";'
    },
    {
      path: "/node_modules/@foo/foo.js",
      content: "console.log('cool')"
    }
  );
  const app = express().use(esm({ fs }));
  const response = await request(app).get("/client/app.js");
  expect(response.status).toEqual(200);
  expect(response.text).toMatchSnapshot();
});

test("skips module processing when ?nomodule=true", async () => {
  const fs = {};
  const app = express().use(esm({ fs }));
  app.get("/client/app.js", (req, res) => {
    res.setHeader("Content-Type", "application/javascript");
    res.send(200, 'import foo from "foo";');
  });
  const response = await request(app).get("/client/app.js?nomodule=true");
  expect(response.status).toEqual(200);
  expect(response.text).toMatchSnapshot();
});

test("doesn't crash on export specifiers with no source", async () => {
  const response = await request(
    express().use(
      esm({
        fs: createMockFs().addFiles(
          {
            path: "/client/app.js",
            content: 'import foo from "foo"; export { foo };'
          },
          {
            path: "/node_modules/foo/package.json",
            content: JSON.stringify({ module: "es/index.js" })
          }
        )
      })
    )
  ).get("/client/app.js");
  expect(response.status).toEqual(200);
  expect(response.text).toMatchSnapshot();
});

test("resolves modules without extension", async () => {
  const fs = createMockFs().addFiles(
    {
      path: "/client/app.js",
      content: 'import foo from "@foo/foo";'
    },
    {
      path: "/node_modules/@foo/foo.js",
      content: "console.log('javascript is cool!')"
    }
  );
  const app = express().use(esm({ fs }));
  const response = await request(app).get("/client/app.js");
  expect(response.status).toEqual(200);
  expect(response.text).toMatchSnapshot();
});

test("resolves user modules with missing extension", async () => {
  const fs = createMockFs().addFiles(
    {
      path: "/client/app.js",
      content: 'import foo from "./foo";'
    },
    {
      path: "/client/foo.js",
      content: "console.log('javascript is cool!')"
    }
  );
  const app = express().use(esm({ fs }));
  const response = await request(app).get("/client/app.js");
  expect(response.status).toEqual(200);
  expect(response.text).toMatchSnapshot();
});

test("ignores non JavaScript modules by default", async () => {
  const fs = createMockFs().addFiles(
    {
      path: "/client/app.js",
      content: `
        import "./foo.less";
        import bar from "./bar";
      `
    },
    {
      path: "/client/bar.js",
      content: ""
    }
  );
  const app = express().use(esm({ fs }));
  const response = await request(app).get("/client/app.js");
  expect(response.text).toMatchSnapshot();
});

describe("missing extension", () => {
  test("can import from directory with index.js file inside", async () => {
    const fs = createMockFs().addFiles(
      {
        path: "/client/app.js",
        content: 'import foo from "./foo";'
      },
      {
        path: "/client/foo/index.js",
        content: "export default 'foo';"
      }
    );
    const app = express().use(esm({ fs }));
    const response = await request(app).get("/client/app.js");
    expect(response.text).toMatchSnapshot();
  });

  test("prioritizes JavaScript modules over directories", async () => {
    const fs = createMockFs().addFiles(
      {
        path: "/client/app.js",
        content: 'import foo from "./foo";'
      },
      {
        path: "/client/foo/index.js",
        content: "export default 'foo';"
      },
      {
        path: "/client/foo.js",
        content: "export default 'bar';"
      }
    );
    const app = express().use(esm({ fs }));
    const response = await request(app).get("/client/app.js");
    expect(response.text).toMatchSnapshot();
  });
});

describe("CommonJS modules", () => {
  test("replaces top-level require() with import statement", async () => {
    const fs = createMockFs().addFiles(
      {
        path: "/node_modules/angular/index.js",
        content: `
          require('./angular');
          module.exports = angular;
        `
      },
      {
        path: "/node_modules/angular/angular.js",
        content: ""
      }
    );
    const app = express().use(esm({ fs }));
    const response = await request(app).get("/node_modules/angular/index.js");
    expect(response.text).toMatchSnapshot();
  });

  test("handles exported literals", async () => {
    const fs = createMockFs().addFiles({
      path: "/node_modules/ui-bootstrap/index.js",
      content: `
        require('./ui-bootstrap.tpls.js');
        module.exports = "ui.bootstrap";
      `
    });
    const app = express().use(esm({ fs }));
    const response = await request(app).get(
      "/node_modules/ui-bootstrap/index.js"
    );
    expect(response.text).toMatchSnapshot();
  });

  test("handles module.exports = require(...)", async () => {
    const fs = createMockFs().addFiles(
      {
        path: "/node_modules/foo/index.js",
        content: `
        module.exports = require("./bar");
      `
      },
      {
        path: "/node_modules/foo/bar.js",
        content: ""
      }
    );
    const app = express().use(esm({ fs }));
    const response = await request(app).get("/node_modules/foo/index.js");
    expect(response.text).toMatchSnapshot();
  });

  test("handles mixed module.exports = require(...) and spare require(...)", async () => {
    const fs = createMockFs().addFiles(
      {
        path: "/node_modules/babel-runtime/core-js/object/keys.js",
        content: `
          require('../../modules/es6.object.keys');
          module.exports = require('../../modules/_core').Object.keys;
        `
      },
      {
        path: "/node_modules/babel-runtime/modules/es6.object.keys.js",
        content: ""
      },
      {
        path: "/node_modules/babel-runtime/modules/_core/index.js",
        content: ""
      }
    );
    const app = express().use(esm({ fs }));
    const response = await request(app).get(
      "/node_modules/babel-runtime/core-js/object/keys.js"
    );
    expect(response.text).toMatchSnapshot();
  });

  test("handles require() from directory", async () => {
    const fs = createMockFs().addFiles(
      {
        path: "/node_modules/babel-runtime/core-js/symbol.js",
        content: `
          module.exports = { "default": require("core-js/library/fn/symbol"), __esModule: true };
        `
      },
      {
        path: "/node_modules/core-js/library/fn/symbol/index.js",
        content: ""
      }
    );
    const app = express().use(esm({ fs }));
    const response = await request(app).get(
      "/node_modules/babel-runtime/core-js/symbol.js"
    );
    expect(response.text).toMatchSnapshot();
  });
});
