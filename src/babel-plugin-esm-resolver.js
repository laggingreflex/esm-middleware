const ospath = require("path");
const t = require("@babel/types");
const { JS_FILE_PATTERN } = require("./constants");
const { resolveModule } = require("./resolve-module");

/**
 * Babel plugin handbook https://github.com/jamiebuilds/babel-handbook/blob/master/translations/en/plugin-handbook.md
 * ESTree AST reference https://github.com/babel/babylon/blob/master/ast/spec.md
 */

const PATH_SEPARATOR_REPLACER = /[/\\]+/g;

/**
 * @param {babel.types.Identifier} e
 * @returns {function}
 */
function toAssignmentExpressions(e) {
  return function fn(p) {
    if (p.isExpressionStatement()) {
      p = p.get("expression");
    }
    if (p.isSequenceExpression()) {
      const result = [];
      for (const exp of p.get("expressions")) {
        result.push(...fn(exp));
      }
      return result;
    }
    if (!p.isAssignmentExpression({ operator: "=" })) {
      return [];
    }
    const left = p.get("left");
    if (!left.isMemberExpression()) {
      return [];
    }
    const object = left.get("object");
    if (object.isIdentifier({ name: e.node.name })) {
      return [p];
    }
    return [];
  };
}

/**
 *
 * @param {babel.NodePath<babel.types.Identifier>} p
 * @returns {babel.NodePath<babel.types.AssignmentExpression>[]} list of all assignment expressions like
 *  e.foo = 'bar' where `e` is a reference to the exports object.
 */
function findExportedBindings(p) {
  if (p.node.name !== "exports") {
    return [];
  }
  /**
   * we're looking for a call expression where exports
   * is one of the arguments, something like t(exports)
   */
  if (!p.inList || p.listKey !== "arguments") {
    return [];
  }
  const callee = p.parentPath.get("callee");
  if (!callee.isIdentifier()) {
    return [];
  }
  const pfe = p.findParent(t => t.isFunctionExpression());
  if (!pfe) {
    /**
     * the call expression involving `exports` as one of its arguments
     * happens as a top level statement, e.g.
     *
     * foo(exports);
     */
    return [];
  }
  const calleePosition = pfe.get("params").findIndex(p => {
    return p.isIdentifier() && p.node.name === callee.node.name;
  });
  if (calleePosition === -1) {
    return [];
  }
  const factoryCall = pfe.findParent(t => t.isCallExpression());
  if (!factoryCall) {
    return [];
  }
  const ffe = factoryCall.get("arguments." + calleePosition);
  /**
   * it's the identifier referencing the exports object
   * within the function expression where the exported bindings
   * are actually assigned to the exports object
   */
  const e = ffe.get("params." + p.key);
  if (!e) {
    return [];
  }
  /**
   * now we just need to look for all the assignment expressions
   * where the left node is a member expression having the `e`
   * identifier as the object node
   */
  return ffe
    .get("body")
    .get("body")
    .map(toAssignmentExpressions(e))
    .flat();
}

/**
 * @typedef {Object} BabelPluginEsmResolverOptions
 * @property {string} currentModuleAbsolutePath
 * @property {import("./esm-middleware").EsmMiddlewareConfigObject} config
 */

/**
 * @typedef {Object} BabelPluginEsmResolverState
 * @property {BabelPluginEsmResolverOptions} opts
 */

/**
 * @returns {babel.PluginObj<BabelPluginEsmResolverState>}
 */
module.exports = () => ({
  name: "esm-resolver",
  visitor: {
    Program: {
      exit(path) {
        /**
         * Here we check whether there are still any references left
         * to the global `module` and `exports` bindings after that
         * the AST transformations are applied (some of the
         * transformations remove the global references completely,
         * e.g. module.exports = foo --> export default foo).
         * If there is some reference left, we shadow global
         * `module` and `exports` bindings by pushing their local
         * counterparts to the program scope.
         *
         * It seems that Babel does not automatically update scope
         * info (e.g. reference count, globals etc) when the AST
         * changes so we need to manually do it by calling crawl().
         */
        path.scope.crawl();
        if (
          !path.scope.hasGlobal("module") &&
          !path.scope.hasGlobal("exports")
        ) {
          return;
        }
        const mod = t.variableDeclaration("const", [
          t.variableDeclarator(
            t.identifier("module"),
            t.objectExpression([
              t.objectProperty(t.identifier("exports"), t.objectExpression([]))
            ])
          )
        ]);
        const exp = t.variableDeclaration("const", [
          t.variableDeclarator(
            t.identifier("exports"),
            t.memberExpression(t.identifier("module"), t.identifier("exports"))
          )
        ]);
        const s = path.get("body").filter(n => n.isImportDeclaration());
        if (s.length > 0) {
          s[s.length - 1].insertAfter([mod, exp]);
        } else {
          path.unshiftContainer("body", [mod, exp]);
        }
        if (path.get("body").find(n => n.isExportDefaultDeclaration())) {
          return;
        }
        const edd = t.exportDefaultDeclaration(
          t.memberExpression(t.identifier("module"), t.identifier("exports"))
        );
        path.pushContainer("body", edd);
      }
    },
    Identifier(path) {
      const program = path.findParent(n => n.isProgram());
      const ae = findExportedBindings(path);
      for (let expr of ae) {
        // turns exports.foo = 'bar' into export const foo = exports.foo;
        const e = t.identifier("exports");
        const pr = t.identifier(expr.get("left").get("property").node.name);
        const me = t.memberExpression(e, pr);
        if (pr.name === "default") {
          // add export default declaration if the named export's name is `default`
          const edd = t.exportDefaultDeclaration(me);
          program.pushContainer("body", edd);
          continue;
        }
        const vd = t.variableDeclarator(pr, me);
        const vad = t.variableDeclaration("const", [vd]);
        const es = t.exportSpecifier(pr, pr);
        const end = t.exportNamedDeclaration(vad, [es]);
        program.pushContainer("body", end);
      }
    },
    AssignmentExpression: {
      exit(path) {
        if (path.scope.parent !== null) {
          return;
        }
        const left = path.get("left");
        if (!left.isMemberExpression()) {
          return;
        }
        if (
          !left.get("object").isIdentifier({ name: "module" }) ||
          !left.get("property").isIdentifier({ name: "exports" })
        ) {
          return;
        }
        if (
          path.parentPath.isExpressionStatement() &&
          path.parentPath.get("expression") === path
        ) {
          /**
           * simple case where assignment to module.exports happens on a standalone
           * assignment expression, e.g.
           *
           *   module.exports = foo;
           *
           * we simply rewrite it as:
           *
           *   export default foo;
           */
          path.replaceWithMultiple(
            t.exportDefaultDeclaration(path.get("right").node)
          );
          return;
        }

        /**
         * module.exports assignment expression's is the right node of an
         * assignment expression itself, e.g.
         *
         *    var assert = foo = bar = module.exports = ok;
         *
         * we rewrite it as:
         *
         *    export default ok;
         *    var assert = foo = bar = ok;
         */
        const right = path.get("right");
        const edd = t.exportDefaultDeclaration(right.node);
        path.find(pp => pp.isProgram()).unshiftContainer("body", edd);
        path.replaceWith(right.node);
      }
    },
    CallExpression(path) {
      if (!path.get("callee").isIdentifier({ name: "require" })) {
        return;
      }
      if (path.parentPath.isVariableDeclarator()) {
        /**
         * the require() call is the init expression in a simple variable
         * declaration statement, something like
         *
         *     var x = require("./x"),
         *         y = require("./y");
         *
         * in this case, we simply replace each require call with an
         * import statement, e.g.
         *
         *     import x from "./x";
         *     import y from "./y"
         *
         */
        const idefspec = t.importDefaultSpecifier(
          path.parentPath.get("id").node
        );
        const idefdec = t.importDeclaration(
          [idefspec],
          path.get("arguments.0").node
        );
        path.findParent(p => p.isProgram()).unshiftContainer("body", idefdec);
        path.parentPath.remove();
        return;
      }
      if (path.getStatementParent().get("expression") === path) {
        /**
         * if we get here, we are on a standalone require call (the parent
         * statement is the require() call expression itself), e.g.
         *
         *    require("./foo");
         *
         * we simply replace it with an import default declaration
         * with no specifiers, e.g.
         *
         *    import "./foo";
         */
        const standalone = t.importDeclaration(
          [],
          path.get("arguments.0").node
        );
        path.remove();
        path.find(p => p.isProgram()).unshiftContainer("body", standalone);
        return;
      }
      /**
       * general way to process require() calls, it turns something like:
       *
       *    module.exports = require("bar");
       *
       * into
       *
       *    import _require from "bar";
       *    export default _require;
       *
       * that is, it replaces the require call with a unique identifier and
       * assigns the imported binding to it.
       *
       * TODO: this algorithm needs to be improved because it might cause
       * issues with cyclic dependencies.
       */
      const binding = path.scope.generateUidIdentifier("require");
      const ispec = t.importDefaultSpecifier(binding);
      const idec = t.importDeclaration([ispec], path.get("arguments.0").node);
      path.replaceWith(binding);
      path.find(p => p.isProgram()).unshiftContainer("body", idec);
    },
    /**
     * @param {babel.NodePath<babel.types.ImportDeclaration | babel.types.ExportAllDeclaration | babel.types.ExportNamedDeclaration>} path
     * @param {BabelPluginEsmResolverState} state
     */
    "ImportDeclaration|ExportAllDeclaration|ExportNamedDeclaration"(
      path,
      state
    ) {
      if (!path.node.source) {
        return;
      }
      const { config, currentModuleAbsolutePath } = state.opts;
      const source = resolveModule(
        path.node.source.value,
        ospath.dirname(currentModuleAbsolutePath),
        config
      );
      if (source === null || !JS_FILE_PATTERN.test(source)) {
        if (config.removeUnresolved) {
          path.remove();
        }
      } else {
        path.node.source.value = source.replace(PATH_SEPARATOR_REPLACER, "/");
      }
    },
    VariableDeclarator(path) {
      /**
       * here we are looking for something like:
       *
       *    var x = require("x");
       *    var x = require("x");
       *
       * that is, distinct variable declarators redeclaring the
       * same identifier
       */
      if (path.node.id.type !== "Identifier") {
        return;
      }
      const init = path.get("init");
      if (
        !init.isCallExpression() ||
        !init.get("callee").isIdentifier({ name: "require" })
      ) {
        return;
      }
      const binding = path.scope.getBinding(path.node.id.name);
      if (!binding || binding.constant) {
        return;
      }
      /**
       * we remove all the duplicates
       */
      binding.constantViolations
        .filter(p => p.isVariableDeclarator())
        .forEach(p => p.remove());
    }
  }
});
