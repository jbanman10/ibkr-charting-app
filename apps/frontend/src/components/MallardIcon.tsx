// The app's mallard mascot — green head, white neck ring, yellow bill.
// Used in the toolbar brand and the alert toasts.
export default function MallardIcon({ size = 20 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none">
      {/* tail flick */}
      <path d="M19 10.5 L22.6 8 C22.9 11 21.9 13 20 14 Z" fill="#8f99a3"/>
      {/* body (grey) */}
      <path d="M4.5 13.5c0 4.3 3.3 6.8 7.8 6.8s7.9-2.5 7.9-6.6c0-1.7-1.5-3.2-3.5-3.2h-8.7c-2 0-3.5 1.4-3.5 3Z" fill="#9aa4ae"/>
      {/* chestnut breast (front of body, under the head) */}
      <path d="M4.5 13.5c0 2.5 1.1 4.4 3 5.6 1.6-1.5 2.5-3.5 2.5-5.8 0-1-.2-2-.5-2.8H8c-2 0-3.5 1.4-3.5 3Z" fill="#7a4a2b"/>
      {/* white neck ring (arc where head meets body) */}
      <circle cx="8.2" cy="7.4" r="4.35" stroke="#f2efe6" strokeWidth="1.1" fill="none"
        strokeDasharray="7.5 19.8" transform="rotate(52 8.2 7.4)"/>
      {/* head (mallard green) */}
      <circle cx="8.2" cy="7.4" r="4" fill="#1f9d55"/>
      {/* bill (yellow) */}
      <path d="M4.3 6.8 L1.2 8 L4.5 9.4 C4.2 8.5 4.2 7.6 4.3 6.8 Z" fill="#f0c437"/>
      {/* eye */}
      <circle cx="7.4" cy="6.4" r="0.85" fill="#0b0e11"/>
      {/* wing (darker) */}
      <path d="M10.8 14c2.3-.7 4.4-.1 5 1.4-1.7 1.3-4 1.1-5.4-.2Z" fill="rgba(0,0,0,0.22)"/>
    </svg>
  );
}
