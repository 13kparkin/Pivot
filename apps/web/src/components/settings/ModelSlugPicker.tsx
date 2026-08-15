"use client";

import { CheckIcon, ChevronDownIcon, PlusIcon, SearchIcon } from "lucide-react";
import { useMemo, useState } from "react";

import {
  Combobox,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxTrigger,
} from "../ui/combobox";

/**
 * Select-with-search for model slugs in provider settings. The trigger shows
 * the committed slug (or the placeholder); the popup filters the instance's
 * known slugs (built-in probe models plus custom models). A typed value that
 * matches nothing is offered as an "Add" row so custom slugs stay possible
 * without leaving the picker.
 */
export function ModelSlugPicker({
  ariaLabel,
  value,
  slugs,
  placeholder = "provider/model",
  onCommit,
}: {
  ariaLabel: string;
  /** Committed slug; empty string means unset. */
  value: string;
  /** Known model slugs to offer as choices. */
  slugs: readonly string[];
  placeholder?: string | undefined;
  onCommit: (next: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");

  const handleOpenChange = (nextOpen: boolean) => {
    setOpen(nextOpen);
    if (nextOpen) setQuery("");
  };

  const items = useMemo(() => {
    const trimmed = query.trim();
    const normalized = trimmed.toLocaleLowerCase();
    const matches = slugs.filter(
      (slug) => normalized.length === 0 || slug.toLocaleLowerCase().includes(normalized),
    );
    // Creatable fallback: the exact typed slug becomes an "Add" row.
    return trimmed.length > 0 && !matches.includes(trimmed) ? [...matches, trimmed] : matches;
  }, [query, slugs]);

  const handlePick = (next: string) => {
    setOpen(false);
    onCommit(next);
  };

  return (
    <Combobox
      items={items}
      filteredItems={items}
      filter={null}
      autoHighlight
      open={open}
      onOpenChange={handleOpenChange}
      value={value}
      onValueChange={(next) => {
        if (typeof next === "string") handlePick(next);
      }}
    >
      <ComboboxTrigger
        aria-label={ariaLabel}
        className="relative inline-flex h-8 w-full min-w-40 cursor-pointer select-none items-center justify-between gap-2 rounded-md border border-input bg-background px-2.5 text-left font-mono text-xs text-foreground shadow-xs outline-none transition-[color,box-shadow] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/24 dark:bg-input/32"
      >
        <span className="min-w-0 truncate">{value.length === 0 ? placeholder : value}</span>
        <ChevronDownIcon className="-me-0.5 size-3 shrink-0 text-muted-foreground opacity-50" />
      </ComboboxTrigger>
      <ComboboxPopup align="start" className="flex w-72 flex-col">
        <div className="shrink-0 px-3 pt-2.5">
          <div className="relative -translate-y-px border-b border-border/70 pb-1.5 transition-colors focus-within:border-ring">
            <SearchIcon
              aria-hidden="true"
              className="pointer-events-none absolute top-1.5 left-0 size-4 shrink-0 text-muted-foreground/55"
            />
            <ComboboxInput
              className="[&_input]:h-6.5 [&_input]:ps-5 [&_input]:font-sans [&_input]:leading-6.5"
              inputClassName="rounded-none bg-transparent font-mono text-xs"
              placeholder="Search models…"
              showTrigger={false}
              size="sm"
              unstyled
              value={query}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
        </div>
        <div className="flex min-h-0 max-h-64 flex-1 flex-col overflow-hidden">
          <ComboboxEmpty>No matching models</ComboboxEmpty>
          <ComboboxList className="p-1">
            {items.map((item, index) => {
              const isAddRow = query.trim().length > 0 && !slugs.includes(item);
              return (
                <ComboboxItem hideIndicator key={item} index={index} value={item}>
                  <div className="flex w-full min-w-0 items-center justify-between gap-2 font-mono text-xs">
                    <span className="min-w-0 truncate">{item}</span>
                    <span className="flex shrink-0 items-center gap-1.5">
                      {isAddRow ? (
                        <span className="flex items-center gap-1 text-[10px] text-muted-foreground">
                          <PlusIcon className="size-3" />
                          Add
                        </span>
                      ) : item === value ? (
                        <CheckIcon className="size-3.5 text-muted-foreground" />
                      ) : null}
                    </span>
                  </div>
                </ComboboxItem>
              );
            })}
          </ComboboxList>
        </div>
      </ComboboxPopup>
    </Combobox>
  );
}
