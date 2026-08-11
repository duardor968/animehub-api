module.exports = function pLimit() {
  return (task) =>
    (...args) =>
      Promise.resolve(task(...args));
};
