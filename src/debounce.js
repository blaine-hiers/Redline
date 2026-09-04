// A trailing-edge debounce with a flush, so pending writes can be forced out
// before the app quits instead of dying with the timer.
function debounced(fn, ms) {
  let timer = null;
  const call = () => {
    clearTimeout(timer);
    timer = setTimeout(() => { timer = null; fn(); }, ms);
  };
  call.flush = () => {
    if (!timer) return;
    clearTimeout(timer);
    timer = null;
    fn();
  };
  return call;
}

module.exports = { debounced };
