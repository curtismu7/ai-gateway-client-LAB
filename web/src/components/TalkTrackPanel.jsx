import React from 'react';
import talkTrack from '../../../docs/talk-track.md?raw';

// The talk track (docs/talk-track.md) as the presenter's script. Plain text only: headings, numbered steps and paragraphs.
export default function TalkTrackPanel() {
  const lines = talkTrack.split('\n');
  return (
    <div className="talk" data-testid="talk-track-list">
      {lines.map((l, i) => {
        if (!l.trim()) return null;
        if (/^#{1,3}\s/.test(l)) return <h3 key={i}>{l.replace(/^#+\s*/, '')}</h3>;
        return <p key={i} className={/^\d+\./.test(l) ? 'talk__step' : ''}>{l}</p>;
      })}
    </div>
  );
}
