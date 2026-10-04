"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

function imageType(bytes: Uint8Array) {
  const starts = (...signature: number[]) =>
    signature.every((byte, index) => bytes[index] === byte);
  if (starts(137, 80, 78, 71, 13, 10, 26, 10)) return "image/png";
  if (starts(255, 216, 255)) return "image/jpeg";
  const text = new TextDecoder().decode(bytes.slice(0, 12));
  if (text.startsWith("GIF87a") || text.startsWith("GIF89a"))
    return "image/gif";
  if (text.startsWith("RIFF") && text.slice(8) === "WEBP") return "image/webp";
  return null;
}

export function FileThumbnail({
  id,
  organization,
  fallback,
}: {
  id: string;
  organization: string;
  fallback: ReactNode;
}) {
  const container = useRef<HTMLSpanElement>(null);
  const [source, setSource] = useState("");
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl = "";
    let started = false;
    async function load() {
      if (started) return;
      started = true;
      try {
        const response = await fetch(`/app-api/files/${id}`, {
          cache: "no-store",
          headers: { "X-Cupboard-Organization": organization },
          signal: controller.signal,
        });
        if (!response.ok) return;
        const bytes = new Uint8Array(await response.arrayBuffer());
        const type = imageType(bytes);
        if (!type || controller.signal.aborted) return;
        objectUrl = URL.createObjectURL(new Blob([bytes], { type }));
        setSource(objectUrl);
      } catch {
        // Keep the file icon when a preview cannot be loaded.
      }
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          observer.disconnect();
          void load();
        }
      },
      { rootMargin: "200px" },
    );
    if (container.current) observer.observe(container.current);
    return () => {
      observer.disconnect();
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [id, organization]);
  return (
    <span
      ref={container}
      className="flex size-full items-center justify-center overflow-hidden rounded-lg"
    >
      {source && !failed ? (
        // Blob URLs hold authenticated raster data and do not need Next image optimization.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          src={source}
          alt=""
          className="size-full bg-white object-contain"
          onError={() => setFailed(true)}
        />
      ) : (
        fallback
      )}
    </span>
  );
}
