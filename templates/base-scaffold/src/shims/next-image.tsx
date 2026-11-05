// Shim de next/image para un proyecto Vite: los bloques Arc vienen escritos para Next.
// Renderiza un <img> plano y descarta las props propias de Next (fill/priority/sizes...).
import { forwardRef } from 'react';
import type { CSSProperties, ImgHTMLAttributes } from 'react';
import { deferredSrc, PENDING_SRC_ATTR } from '../wt-reveal-bridge';

// Como en Next, src acepta un import estático (changelog-feed lo pasa así); sin el tipo, typecheck falla en el workspace.
export interface StaticImageData {
  src: string;
  height: number;
  width: number;
  blurDataURL?: string;
}

interface NextImageProps extends Omit<ImgHTMLAttributes<HTMLImageElement>, 'src'> {
  src?: string | StaticImageData;
  fill?: boolean;
  priority?: boolean;
  sizes?: string;
  quality?: number;
  placeholder?: string;
  blurDataURL?: string;
}

const NextImage = forwardRef<HTMLImageElement, NextImageProps>(function NextImage(
  { src, fill, priority, quality, placeholder, blurDataURL, loading, style, ...props },
  ref,
) {
  const fillStyle: CSSProperties | undefined = fill
    ? { position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'cover', ...style }
    : style;
  // Con React el <img> nace con su src y el navegador lo pide en el acto; el puente llega tarde. Por eso el diferido de
  // Stitch (vr-runtime :583-590, en su diff del HTML) se hace aquí, donde se crea el nodo.
  const real = typeof src === 'object' ? src.src : src;
  const shown = deferredSrc(real, {
    dataAlt: (props as Record<string, unknown>)['data-alt'] !== undefined,
    // Boolean(): en vite DEV ya es boolean; los tests de la raíz cargan este archivo con los tipos de bun, donde es string.
    dev: Boolean(import.meta.env.DEV),
    generating: typeof window !== 'undefined' && window.__wtGenerating === true,
    loaded: typeof window !== 'undefined' && real !== undefined && window.__wtLoadedSrcs?.has(real) === true,
  });
  return <img ref={ref} src={shown.src} {...(shown.pending ? { [PENDING_SRC_ATTR]: shown.pending } : {})} loading={priority ? 'eager' : loading} style={fillStyle} {...props} />;
});

export default NextImage;
