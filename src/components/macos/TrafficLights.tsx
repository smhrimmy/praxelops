"use client";

import React, { useState } from "react";
import { X, Minus, Maximize2 } from "lucide-react";

interface TrafficLightsProps {
  onClose?: () => void;
  onMinimize?: () => void;
  onMaximize?: () => void;
  isMaximized?: boolean;
}

export const TrafficLights: React.FC<TrafficLightsProps> = ({
  onClose,
  onMinimize,
  onMaximize,
  isMaximized = false,
}) => {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className="flex items-center space-x-2 px-1"
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        onClick={onClose}
        aria-label="Close"
        title="Close window"
        className="traffic-btn traffic-close group relative focus:outline-none"
      >
        {hovered && <X className="w-2.5 h-2.5 text-red-950 font-bold" />}
      </button>

      <button
        onClick={onMinimize}
        aria-label="Minimize"
        title="Minimize window"
        className="traffic-btn traffic-min group relative focus:outline-none"
      >
        {hovered && <Minus className="w-2.5 h-2.5 text-amber-950 font-bold" />}
      </button>

      <button
        onClick={onMaximize}
        aria-label="Maximize"
        title={isMaximized ? "Restore window" : "Maximize window"}
        className="traffic-btn traffic-max group relative focus:outline-none"
      >
        {hovered && (
          <Maximize2 className="w-2.5 h-2.5 text-emerald-950 font-bold" />
        )}
      </button>
    </div>
  );
};
