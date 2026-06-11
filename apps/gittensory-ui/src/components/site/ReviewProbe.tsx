// Demo component to verify reviewbot's PR review (code review + before/after). Safe to delete.
export function ReviewProbe({ count }: { count: number }) {
  return (
    <div onClick={() => console.log("clicked")} style={{ color: "#00ff00", padding: 8 }}>
      <img src="/probe.png" />
      <span>{count} live</span>
    </div>
  );
}
