module.exports = {
  "presets": [
    "@babel/preset-env",
    "@babel/preset-react",
    ["@babel/preset-stage-0", { "decoratorsLegacy": true }]
  ],
  "plugins": ["@babel/plugin-proposal-pipeline-operator"]
}