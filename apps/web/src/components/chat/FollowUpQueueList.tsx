import { memo } from "react";
import { PencilIcon, XIcon } from "lucide-react";
import type { FollowUpQueueItem } from "~/lib/followUpQueue";
import { Button } from "../ui/button";
import { cn } from "~/lib/utils";

type FollowUpQueueListProps = {
  readonly items: ReadonlyArray<FollowUpQueueItem>;
  readonly onRemove: (id: string) => void;
  readonly onEdit: (id: string) => void;
  readonly className?: string;
};

export const FollowUpQueueList = memo(function FollowUpQueueList({
  items,
  onRemove,
  onEdit,
  className,
}: FollowUpQueueListProps) {
  if (items.length === 0) {
    return null;
  }

  return (
    <div
      className={cn(
        "mb-2 flex flex-col gap-1.5 rounded-2xl border border-border/50 bg-muted/30 px-3 py-2",
        className,
      )}
      data-follow-up-queue="true"
    >
      <div className="text-[11px] font-medium text-secondary-label">Queued · {items.length}</div>
      <ul className="flex flex-col gap-1.5">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex items-start gap-2 rounded-xl bg-background/70 px-2.5 py-2 text-sm"
          >
            <p className="min-w-0 flex-1 whitespace-pre-wrap break-words text-foreground/90">
              {item.text}
            </p>
            <div className="flex shrink-0 items-center gap-0.5">
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Edit queued message"
                onClick={() => onEdit(item.id)}
              >
                <PencilIcon className="size-3.5" />
              </Button>
              <Button
                type="button"
                size="icon-xs"
                variant="ghost"
                aria-label="Remove queued message"
                onClick={() => onRemove(item.id)}
              >
                <XIcon className="size-3.5" />
              </Button>
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
});
