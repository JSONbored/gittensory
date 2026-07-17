import { cn } from "../utils";

function Skeleton({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return (
    <div
      className={cn("motion-safe:animate-pulse rounded-md bg-primary/10", className)}
      aria-hidden="true"
      {...props}
    />
  );
}

export { Skeleton };
