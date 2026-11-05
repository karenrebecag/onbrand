import { describe, expect, test } from 'bun:test';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EDIT_IMAGE_DEF, EDIT_IMAGE_TOOL, gatewayImageEdit, IMAGE_TOOL, IMAGE_TOOL_DEF, parseEditImageInput, parseImageToolInput, type ImageEdit } from '../src/runtime/image-tool';
import { runWorkspaceTool } from '../src/runtime/workspace-tools';
import { IMAGE_MODEL_ENV, workspaceMcpConfig } from '../src/runtime/workspace-mcp';
import type { ImageGen } from '../src/runtime/image-step';

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52, 0, 0, 5, 64, 0, 0, 3, 64]);
const ctxOf = (dir: string, imageGen?: ImageGen, imageEdit?: ImageEdit) => ({ dir, previews: { ensure: async () => ({ url: 'http://x' }) }, ...(imageGen ? { imageGen } : {}), ...(imageEdit ? { imageEdit } : {}) });

describe('generate_image como tool del agente', () => {
  test('el schema pide prompt y target_path, y solo acepta rutas de public/images', () => {
    expect(IMAGE_TOOL_DEF.input_schema.required).toEqual(['prompt', 'target_path']);
    expect(parseImageToolInput({ prompt: 'a', target_path: 'public/images/hero.jpg' })).toEqual({ ok: true, value: { prompt: 'a', src: '/images/hero.jpg' } });
    expect(parseImageToolInput({ prompt: 'a', target_path: 'src/assets/hero.jpg' }).ok).toBe(false);
    expect(parseImageToolInput({ prompt: 'a', target_path: '/images/../x.jpg' }).ok).toBe(false);
    expect(parseImageToolInput({ prompt: ' ', target_path: '/images/hero.jpg' }).ok).toBe(false);
  });

  test('escribe la imagen con la extensión que devolvió el generador y responde solo texto con la ruta', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-img-'));
    const prompts: string[] = [];
    const gen: ImageGen = async (prompt) => { prompts.push(prompt); return { bytes: PNG, mediaType: 'image/png' }; };
    const r = await runWorkspaceTool(IMAGE_TOOL, { prompt: 'editorial photo', target_path: '/images/acme-hero.jpg' }, ctxOf(dir, gen));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toEqual([{ type: 'text', text: expect.stringContaining('src="/images/acme-hero.png"') }]);
    expect(readFileSync(join(dir, 'public/images/acme-hero.png'))).toEqual(Buffer.from(PNG));
    expect(existsSync(join(dir, 'public/images/acme-hero.jpg'))).toBe(false);
    expect(prompts).toEqual(['editorial photo']);
  });

  test('si el generador falla la tool devuelve el error y la sección sigue sin imagen', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-img-'));
    const r = await runWorkspaceTool(IMAGE_TOOL, { prompt: 'a', target_path: '/images/a.jpg' }, ctxOf(dir, async () => { throw new Error('403 TOP_UP'); }));
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.error).toContain('403');
  });

  test('sin generador la tool no corre, y el config del servidor solo la expone con modelo y fuera de allowedTools', async () => {
    const r = await runWorkspaceTool(IMAGE_TOOL, { prompt: 'a', target_path: '/images/a.jpg' }, ctxOf(mkdtempSync(join(tmpdir(), 'wt-img-'))));
    expect(r.ok).toBe(false);
    expect(workspaceMcpConfig('/ws', 'http://x').allowedTools).not.toContain('mcp__wt__generate_image');
    const on = workspaceMcpConfig('/ws', 'http://x', 'script.ts', { modelId: 'bfl/flux-3-image-klein' });
    // Gasta créditos: el CLI la manda a la permission-prompt-tool en vez de correrla sola.
    expect(on.allowedTools).not.toContain('mcp__wt__generate_image');
    expect(JSON.parse(on.config).mcpServers.wt.env).toEqual({ [IMAGE_MODEL_ENV]: 'bfl/flux-3-image-klein' });
  });
});

// edit_image (S5): sin gasto, con el editor inyectado.
describe('edit_image como tool del agente', () => {
  const wsWith = (files: string[]) => {
    const dir = mkdtempSync(join(tmpdir(), 'wt-edit-'));
    mkdirSync(join(dir, 'public/images'), { recursive: true });
    for (const f of files) writeFileSync(join(dir, 'public/images', f), PNG);
    return dir;
  };

  test('el schema pide prompt, image_path y target_path; inpaint exige máscara y solo rutas de public/images', () => {
    expect(EDIT_IMAGE_DEF.input_schema.required).toEqual(['prompt', 'image_path', 'target_path']);
    expect(parseEditImageInput({ prompt: 'a', image_path: 'public/images/a.png', target_path: '/images/b.jpg' })).toEqual({ ok: true, value: { prompt: 'a', image: '/images/a.png', src: '/images/b.jpg' } });
    expect(parseEditImageInput({ prompt: 'a', image_path: '/images/a.png', target_path: '/images/b.jpg', mode: 'inpaint' }).ok).toBe(false);
    expect(parseEditImageInput({ prompt: 'a', image_path: '/images/a.png', target_path: '/images/b.jpg', mode: 'inpaint', mask_path: '/images/m.png' }).ok).toBe(true);
    expect(parseEditImageInput({ prompt: 'a', image_path: '/images/../a.png', target_path: '/images/b.jpg' }).ok).toBe(false);
    expect(parseEditImageInput({ prompt: 'a', image_path: '/images/a.png', target_path: '/images/b.jpg', mode: 'outpaint' }).ok).toBe(false);
  });

  test('lee el origen y la máscara, escribe el resultado y responde solo texto con la ruta', async () => {
    const dir = wsWith(['a.png', 'm.png']);
    const seen: { prompt: string; image: number; mask?: number }[] = [];
    const edit: ImageEdit = async ({ prompt, image, mask }) => { seen.push({ prompt, image: image.length, mask: mask?.length }); return { bytes: PNG, mediaType: 'image/png' }; };
    const r = await runWorkspaceTool(EDIT_IMAGE_TOOL, { prompt: 'warmer light', image_path: '/images/a.png', target_path: '/images/a-warm.png', mode: 'inpaint', mask_path: '/images/m.png' }, ctxOf(dir, undefined, edit));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.content).toEqual([{ type: 'text', text: expect.stringContaining('src="/images/a-warm.png"') }]);
    expect(existsSync(join(dir, 'public/images/a-warm.png'))).toBe(true);
    expect(seen).toEqual([{ prompt: 'warmer light', image: PNG.length, mask: PNG.length }]);
  });

  test('sin editor la tool no corre, y un origen que no existe se rechaza antes de llamar al modelo', async () => {
    const dir = wsWith([]);
    expect((await runWorkspaceTool(EDIT_IMAGE_TOOL, { prompt: 'a', image_path: '/images/a.png', target_path: '/images/b.png' }, ctxOf(dir))).ok).toBe(false);
    let called = 0;
    const r = await runWorkspaceTool(EDIT_IMAGE_TOOL, { prompt: 'a', image_path: '/images/a.png', target_path: '/images/b.png' }, ctxOf(dir, undefined, async () => { called++; return { bytes: PNG, mediaType: 'image/png' }; }));
    expect(r.ok).toBe(false);
    expect(called).toBe(0);
  });

  // Modelo falso con la forma de ImageModelV4: cuenta si generateImage llegó a llamarlo.
  const fakeModel = (flags: { supportsFileInputs?: unknown; supportsMaskInputs?: unknown }) => {
    const calls = { n: 0 };
    const model = { specificationVersion: 'v4', provider: 't', modelId: 'x/y', maxImagesPerCall: 1, ...flags, doGenerate: async () => { calls.n++; throw new Error('modelo llamado'); } } as never;
    return { model, calls };
  };

  test('supportsFileInputs false no llama al modelo y deja error de texto y la marca de fallo; undefined (gateway) sí lo intenta', async () => {
    const no = fakeModel({ supportsFileInputs: Promise.resolve(false) });
    const dir = wsWith(['a.png']);
    const r = await runWorkspaceTool(EDIT_IMAGE_TOOL, { prompt: 'a', image_path: '/images/a.png', target_path: '/images/b.png' }, ctxOf(dir, undefined, gatewayImageEdit('x/y', no.model)));
    expect(r.ok === false && r.error).toContain('no soporta editar imágenes');
    expect(no.calls.n).toBe(0);
    const unknown = fakeModel({});
    const r2 = await runWorkspaceTool(EDIT_IMAGE_TOOL, { prompt: 'a', image_path: '/images/a.png', target_path: '/images/b.png' }, ctxOf(wsWith(['a.png']), undefined, gatewayImageEdit('x/y', unknown.model)));
    expect(unknown.calls.n).toBe(1);
    expect(r2.ok === false && r2.error).toContain('modelo llamado');
  });

  test('con máscara, supportsMaskInputs false no llama al modelo y undefined lo intenta', async () => {
    const args = { prompt: 'a', image_path: '/images/a.png', target_path: '/images/b.png', mask_path: '/images/m.png' };
    const no = fakeModel({ supportsFileInputs: true, supportsMaskInputs: false });
    const r = await runWorkspaceTool(EDIT_IMAGE_TOOL, args, ctxOf(wsWith(['a.png', 'm.png']), undefined, gatewayImageEdit('x/y', no.model)));
    expect(r.ok === false && r.error).toContain('no soporta máscaras');
    expect(no.calls.n).toBe(0);
    const unknown = fakeModel({ supportsFileInputs: true });
    await runWorkspaceTool(EDIT_IMAGE_TOOL, args, ctxOf(wsWith(['a.png', 'm.png']), undefined, gatewayImageEdit('x/y', unknown.model)));
    expect(unknown.calls.n).toBe(1);
  });

  test('gasta créditos: pasa por la aprobación spend y no está en allowedTools', async () => {
    const { SPEND_TOOLS } = await import('../src/runtime/approvals');
    expect(SPEND_TOOLS.has('mcp__wt__edit_image')).toBe(true);
    expect(workspaceMcpConfig('/ws', 'http://x', 'script.ts', { modelId: 'bfl/flux-3-image-klein' }).allowedTools).not.toContain('mcp__wt__edit_image');
  });

  // Seguridad (ronda 2026-11-02): readFileSync y writeFileSync siguen symlinks; la regex de rutas no los ve.
  test('un symlink en public/images no deja leer un archivo de fuera ni pisarlo', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'wt-outside-'));
    writeFileSync(join(outside, 'secret.png'), PNG);
    writeFileSync(join(outside, 'secret.txt'), 'API_KEY=hunter2');
    const dir = wsWith([]);
    symlinkSync(join(outside, 'secret.png'), join(dir, 'public/images/leak.png'));
    symlinkSync(join(outside, 'secret.txt'), join(dir, 'public/images/note.png'));
    let sent = 0;
    const edit: ImageEdit = async () => { sent++; return { bytes: new Uint8Array([...PNG, 1]), mediaType: 'image/png' }; };
    const read = await runWorkspaceTool(EDIT_IMAGE_TOOL, { prompt: 'a', image_path: '/images/leak.png', target_path: '/images/out.png' }, ctxOf(dir, undefined, edit));
    expect(read.ok).toBe(false);
    // Un archivo de texto con nombre .png tampoco sale hacia el proveedor.
    expect((await runWorkspaceTool(EDIT_IMAGE_TOOL, { prompt: 'a', image_path: '/images/note.png', target_path: '/images/out.png' }, ctxOf(dir, undefined, edit))).ok).toBe(false);
    expect(sent).toBe(0);
    writeFileSync(join(dir, 'public/images/ok.png'), PNG);
    const write = await runWorkspaceTool(EDIT_IMAGE_TOOL, { prompt: 'a', image_path: '/images/ok.png', target_path: '/images/leak.png' }, ctxOf(dir, undefined, edit));
    expect(write.ok).toBe(false);
    expect(readFileSync(join(outside, 'secret.png'))).toEqual(Buffer.from(PNG));
    // Lo mismo para generate_image: no pisa el archivo de fuera.
    const gen = await runWorkspaceTool(IMAGE_TOOL, { prompt: 'a', target_path: '/images/leak.png' }, ctxOf(dir, async () => ({ bytes: new Uint8Array([...PNG, 2]), mediaType: 'image/png' })));
    expect(gen.ok).toBe(false);
    expect(readFileSync(join(outside, 'secret.png'))).toEqual(Buffer.from(PNG));
  });

  test('si public/images entera es un symlink a otra carpeta, nada se lee ni se escribe', async () => {
    const outside = mkdtempSync(join(tmpdir(), 'wt-outside-'));
    writeFileSync(join(outside, 'a.png'), PNG);
    const dir = mkdtempSync(join(tmpdir(), 'wt-edit-'));
    mkdirSync(join(dir, 'public'), { recursive: true });
    symlinkSync(outside, join(dir, 'public/images'));
    const edit: ImageEdit = async () => ({ bytes: PNG, mediaType: 'image/png' });
    expect((await runWorkspaceTool(EDIT_IMAGE_TOOL, { prompt: 'a', image_path: '/images/a.png', target_path: '/images/b.png' }, ctxOf(dir, undefined, edit))).ok).toBe(false);
    expect(existsSync(join(outside, 'b.png'))).toBe(false);
  });
});

