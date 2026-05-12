import clsx from "clsx";

export type StatusDotTone =
  | "neutral"
  | "blue"
  | "green"
  | "amber"
  | "red";

const toneClass: Record<StatusDotTone, string> = {
  neutral: "bg-slate-300",
  blue: "bg-blue-500",
  green: "bg-emerald-500",
  amber: "bg-amber-500",
  red: "bg-red-500",
};

export function StatusDot({
  tone = "neutral",
  pulse = false,
  className,
}: {
  tone?: StatusDotTone;
  pulse?: boolean;
  className?: string;
}) {
  return (
    <span
      aria-hidden
      className={clsx(
        "inline-block h-1.5 w-1.5 shrink-0 rounded-full",
        toneClass[tone],
        pulse && "animate-pulseDot",
        className,
      )}
    />
  );
}
