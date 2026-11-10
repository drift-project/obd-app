// The time line of a recording.
//
// Car rows and phone samples of one session are stamped by one clock, so they
// line up. The wall clock is read once and a steady clock counts from there:
// the wall clock alone can jump in the middle of a drive when the phone sets
// it from the network, and a jump would tear the recording apart.
//
// The steady clock has one weakness: while the phone sleeps it can stand
// still. The session then continues behind the real time by the length of the
// sleep. `catchUp()` moves it on to the wall clock; it is called when the page
// comes back to the front, where nothing was recorded in between.

const BEHIND_MS = 500; // less than this is the two clocks reading slightly differently, not a sleep

/**
 * `wall()` gives milliseconds since 1970 and `steady()` milliseconds on a
 * clock that never jumps; tests pass their own.
 */
export function sessionClock({ wall = Date.now, steady = () => performance.now() } = {}) {
  let offset = wall() - steady();
  return {
    /** Milliseconds since 1970 on the session's time line. */
    now: () => offset + steady(),
    /** The same for a moment given on the steady clock, which is how sensors stamp their readings. */
    fromTicks: (ticks) => offset + ticks,
    /**
     * Move on to the wall clock if the session fell behind it and return by
     * how many milliseconds (0 when it did not). It never moves back, so the
     * times of a recording stay in order.
     */
    catchUp() {
      const fresh = wall() - steady();
      const behind = fresh - offset;
      if (behind < BEHIND_MS) return 0;
      offset = fresh;
      return Math.round(behind);
    },
  };
}
