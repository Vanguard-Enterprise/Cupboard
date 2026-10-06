"use client";

import { useRef } from "react";
import { Trash2Icon } from "lucide-react";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";

export function OrganizationLogoPicker({
  disabled,
  hasLogo,
  error,
  loading,
  onSelect,
  onRemove,
  onRetry,
}: {
  disabled: boolean;
  hasLogo: boolean;
  error: string;
  loading: boolean;
  onSelect: (file: File) => void;
  onRemove: () => void;
  onRetry?: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <div className="space-y-2">
      <Label htmlFor="logo-file">Upload organization logo</Label>
      <input
        ref={input}
        id="logo-file"
        type="file"
        accept=".png,.jpg,.jpeg,.webp,.gif,.bmp,.ico,.tif,.tiff,.svg"
        className="hidden"
        disabled={disabled}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) onSelect(file);
          event.target.value = "";
        }}
      />
      <div className="flex items-center gap-2">
        <Button
          type="button"
          variant="outline"
          className="min-h-11"
          disabled={disabled}
          onClick={() => input.current?.click()}
        >
          {hasLogo ? "Replace logo" : "Select logo"}
        </Button>
        {hasLogo && (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="destructive"
                size="icon"
                className="size-11"
                disabled={disabled}
                aria-label="Remove logo"
                onClick={onRemove}
              >
                <Trash2Icon className="size-4" aria-hidden="true" />
              </Button>
            </TooltipTrigger>
            <TooltipContent>Remove logo</TooltipContent>
          </Tooltip>
        )}
      </div>
      {loading && (
        <p role="status" className="text-sm text-muted-foreground">
          Preparing logo...
        </p>
      )}
      {error && (
        <div role="alert" className="space-y-2 text-sm text-destructive">
          <p>{error}</p>
          {onRetry && (
            <Button
              type="button"
              variant="outline"
              disabled={loading}
              onClick={onRetry}
            >
              Reload logo
            </Button>
          )}
        </div>
      )}
    </div>
  );
}
