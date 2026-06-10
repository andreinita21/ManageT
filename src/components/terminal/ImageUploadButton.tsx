"use client";

/**
 * ImageUploadButton — a photo-icon button + hidden file input.
 *
 * Used wherever a terminal pane exposes its "send image" handler: the
 * /terminal tab bar (acts on the active tab) and each group-mosaic cell
 * bar. The pane does the actual upload + paste; this component only
 * picks the file. Styling is fully caller-supplied so it can blend into
 * either bar.
 */
import { useRef } from "react";

interface ImageUploadButtonProps {
  onPick: (file: File) => void;
  disabled?: boolean;
  className?: string;
  iconClassName?: string;
  title?: string;
}

export function ImageUploadButton({
  onPick,
  disabled = false,
  className = "",
  iconClassName = "w-4 h-4",
  title = "Send an image to this terminal",
}: ImageUploadButtonProps) {
  const inputRef = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        disabled={disabled}
        onClick={(e) => {
          e.stopPropagation();
          inputRef.current?.click();
        }}
        // The mosaic cell bar is draggable (reorder) — keep the button
        // from starting a drag, same as its sibling controls.
        draggable={false}
        onDragStart={(e) => e.preventDefault()}
        className={className}
        title={title}
        aria-label={title}
      >
        <svg
          className={iconClassName}
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={2}
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" ry="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="M21 15l-5-5L5 21" />
        </svg>
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/png,image/jpeg,image/gif,image/webp"
        className="hidden"
        onChange={(e) => {
          const f = e.target.files?.[0];
          // Reset so picking the same file twice re-fires onChange.
          e.target.value = "";
          if (f) onPick(f);
        }}
      />
    </>
  );
}
