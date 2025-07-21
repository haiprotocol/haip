module.exports = {
    parser: "@typescript-eslint/parser",
    parserOptions: {
        ecmaVersion: 2020,
        sourceType: "module",
    },
    plugins: ["@typescript-eslint"],
    extends: [
        "eslint:recommended",
        "prettier",
    ],
    rules: {
        "@typescript-eslint/no-unused-vars": "error",
        "@typescript-eslint/no-explicit-any": "warn",
        "prefer-const": "error",
        "no-var": "error",
        "no-undef": "off",
    },
    env: {
        node: true,
        es6: true,
    },
    globals: {
        NodeJS: "readonly",
        EventSource: "readonly",
    },
}; 