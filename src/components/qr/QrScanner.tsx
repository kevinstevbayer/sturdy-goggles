"use client";

import { useEffect, useRef, useState } from "react";
import { Camera, X } from "lucide-react";
import { t } from "@/lib/i18n";

interface QrScannerProps {
  onScan: (rawText: string) => void;
  onClose?: () => void;
  compact?: boolean;
}

export function QrScanner({ onScan, onClose, compact = false }: QrScannerProps) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const firedRef = useRef(false);

  useEffect(() => {
    let active = true;
    let controls: { stop: () => void } | null = null;

    async function start() {
      try {
        const { BrowserQRCodeReader } = await import("@zxing/browser");
        const reader = new BrowserQRCodeReader();
        if (!videoRef.current || !active) return;

        controls = await reader.decodeFromConstraints(
          {
            audio: false,
            video: { facingMode: { ideal: "environment" } }
          },
          videoRef.current,
          (result) => {
            if (!active || firedRef.current || !result) return;
            const text = result.getText().trim();
            if (text) {
              firedRef.current = true;
              onScan(text);
            }
          }
        );
      } catch {
        if (active) setErrorMsg(t("host.camera_error"));
      }
    }

    void start();

    return () => {
      active = false;
      controls?.stop();
    };
  }, [onScan]);

  return (
    <div className="bg-surface border border-border rounded-card overflow-hidden shadow-soft">
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <span className="inline-flex items-center gap-1.5 text-xs font-semibold">
          <Camera className="w-4 h-4 text-accent" />
          <span>{t("host.scan_camera")}</span>
        </span>
        {onClose && (
          <button
            type="button"
            onClick={onClose}
            className="h-8 px-2.5 rounded-card border border-border text-xs font-medium inline-flex items-center gap-1"
          >
            <X className="w-3.5 h-3.5" />
            <span>{t("common.close")}</span>
          </button>
        )}
      </div>

      {errorMsg ? (
        <p className="p-4 text-sm text-danger text-center">{errorMsg}</p>
      ) : (
        <div className={"relative bg-black " + (compact ? "h-44" : "h-60")}>
          <video
            ref={videoRef}
            playsInline
            muted
            className="w-full h-full object-cover"
          />
          <div className="pointer-events-none absolute inset-6 border-2 border-white/70 rounded-card" />
        </div>
      )}
    </div>
  );
}
