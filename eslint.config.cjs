module.exports = [{
  ignores: [
    "node_modules/**",
    "dist/**",
    "build/**",
    "package-lock.json",
    "*.log"
  ],
  languageOptions: {
    ecmaVersion: 2021,
    sourceType: "module"
  },
  rules: {
    "no-unused-vars": ["warn"],
    "no-console": ["off"]
  }
}];
