import { useState, useRef, KeyboardEvent } from "react";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { X, Plus } from "lucide-react";
import { cn } from "@/lib/utils";

interface TagInputProps {
  value: string[];
  onChange: (tags: string[]) => void;
  placeholder?: string;
  disabled?: boolean;
  maxTags?: number;
  className?: string;
  badgeClassName?: string;
}

export function TagInput({
  value = [],
  onChange,
  placeholder = "Type and press Enter…",
  disabled = false,
  maxTags,
  className,
  badgeClassName,
}: TagInputProps) {
  const [inputVal, setInputVal] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  function addTag(raw: string) {
    const tag = raw.trim();
    if (!tag) return;
    if (value.some((t) => t.toLowerCase() === tag.toLowerCase())) {
      setInputVal("");
      return;
    }
    if (maxTags && value.length >= maxTags) return;
    onChange([...value, tag]);
    setInputVal("");
  }

  function removeTag(index: number) {
    onChange(value.filter((_, i) => i !== index));
  }

  function handleKeyDown(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === "Enter" || e.key === ",") {
      e.preventDefault();
      addTag(inputVal);
    } else if (e.key === "Backspace" && !inputVal && value.length > 0) {
      removeTag(value.length - 1);
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLInputElement>) {
    e.preventDefault();
    const text = e.clipboardData.getData("text");
    // Split by commas, newlines, semicolons
    const parts = text.split(/[,;\n]+/).map((p) => p.trim()).filter(Boolean);
    if (parts.length > 1) {
      const newTags = [...value];
      for (const part of parts) {
        if (!newTags.some((t) => t.toLowerCase() === part.toLowerCase())) {
          if (!maxTags || newTags.length < maxTags) {
            newTags.push(part);
          }
        }
      }
      onChange(newTags);
    } else if (parts.length === 1) {
      setInputVal(parts[0]);
    }
  }

  const atLimit = !!maxTags && value.length >= maxTags;

  return (
    <div
      className={cn(
        "flex flex-wrap gap-1.5 min-h-[42px] w-full rounded-md border border-input bg-background px-3 py-2 text-sm ring-offset-background",
        "focus-within:ring-2 focus-within:ring-ring focus-within:ring-offset-2",
        disabled && "opacity-50 cursor-not-allowed",
        className
      )}
      onClick={() => inputRef.current?.focus()}
    >
      {value.map((tag, i) => (
        <Badge
          key={`${tag}-${i}`}
          className={cn(
            "gap-1 pl-2 pr-1 py-0.5 h-6 font-normal text-xs select-none",
            "bg-primary/15 text-primary border-primary/30 hover:bg-primary/20",
            badgeClassName
          )}
        >
          {tag}
          {!disabled && (
            <button
              type="button"
              onClick={(e) => { e.stopPropagation(); removeTag(i); }}
              className="rounded-sm hover:text-destructive transition-colors ml-0.5"
              tabIndex={-1}
            >
              <X className="w-3 h-3" />
            </button>
          )}
        </Badge>
      ))}
      {!disabled && !atLimit && (
        <input
          ref={inputRef}
          value={inputVal}
          onChange={(e) => setInputVal(e.target.value)}
          onKeyDown={handleKeyDown}
          onPaste={handlePaste}
          onBlur={() => { if (inputVal.trim()) addTag(inputVal); }}
          placeholder={value.length === 0 ? placeholder : ""}
          className="flex-1 min-w-[120px] outline-none bg-transparent placeholder:text-muted-foreground text-sm"
          disabled={disabled}
        />
      )}
      {atLimit && (
        <span className="text-xs text-muted-foreground self-center ml-1">Max {maxTags}</span>
      )}
    </div>
  );
}
