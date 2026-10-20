import { useEffect, useRef, useState } from 'react';
import { apiBlob } from '../image-api.ts';

export function StickerImage({ src, alt }: { src: string; alt: string }) {
  const container = useRef<HTMLDivElement>(null);
  const [objectUrl, setObjectUrl] = useState('');
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let active = true;
    let createdUrl: string | undefined;
    let observer: IntersectionObserver | undefined;
    const load = () => {
      observer?.disconnect();
      void apiBlob(src).then((blob) => {
        if (!active) return;
        createdUrl = URL.createObjectURL(blob);
        setObjectUrl(createdUrl);
      }).catch(() => {
        if (active) setFailed(true);
      });
    };
    if (typeof IntersectionObserver === 'undefined' || !container.current) {
      load();
    } else {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) load();
      }, { rootMargin: '120px' });
      observer.observe(container.current);
    }
    return () => {
      active = false;
      observer?.disconnect();
      if (createdUrl) URL.revokeObjectURL(createdUrl);
    };
  }, [src]);

  return (
    <div className="sticker-image" ref={container}>
      {objectUrl
        ? <img src={objectUrl} alt={alt} />
        : <span className="sticker-image-placeholder">{failed ? '图片不可用' : '加载图片'}</span>}
    </div>
  );
}
