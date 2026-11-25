"use client";

import { useEffect, useState } from "react";
import QRCode from "qrcode";

interface QrCodeSvgProps {
  value: string;
  size?: number;
}

export function QrCodeSvg({ value, size = 140 }: QrCodeSvgProps) {
  const [dataUrl, setDataUrl] = useState<string>("");

  useEffect(() => {
    let active = true;
    QRCode.toDataURL(value, { width: size, margin: 1 })
      .then((url) => {
        if (active) setDataUrl(url);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [value, size]);

  if (!dataUrl) {
    return <div style={{ width: size, height: size }} className="bg-bg rounded" />;
  }

  return (
    <img
      src={dataUrl}
      width={size}
      height={size}
      alt={value}
      className="rounded border border-border bg-white"
    />
  );
}
