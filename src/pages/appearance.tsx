// SPDX-License-Identifier: AGPL-3.0-or-later
// Copyright (C) 2026 Skylar

import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import {
  Check,
  Contrast,
  Image as ImageIcon,
  Loader2,
  Monitor,
  Moon,
  Pipette,
  RotateCcw,
  Sparkles,
  Sun,
  Trash2,
  Type,
  Upload,
  Wand2,
} from 'lucide-react';
import { APP_CONFIG } from '@/config/app-config';
import { NAV } from '@/config/nav';
import { PRESETS } from '@/config/presets';
import { useTheme } from '@/lib/theme-provider';
import { accentCandidates, asAccent, extractPalette, type SampledColor } from '@/lib/palette';
import { GLASS_BLUR_MAX, GLASS_BLUR_MIN, type FontPref, type MotionPref, type RadiusPref } from '@/lib/theme';
import { cn } from '@/lib/utils';
import {
  Button,
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from '@/components/ui/button';
import { Field, Input } from '@/components/ui/field';
import { Slider } from '@/components/ui/slider';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { useToast } from '@/components/ui/toast';

/**
 * Appearance page — the theme studio.
 *
 * Every control writes straight into the theme provider, so changes apply
 * immediately and persist through the storage adapter. That is the whole point
 * of the engine: no "save" round trip, no reload.
 */
export default function AppearancePage() {
  const {
    theme,
    setMode,
    setAccent,
    setBrand,
    setWallpaper,
    setGlass,
    setGlassBlur,
    setGradient,
    setRadius,
    setMotion,
    setFont,
    toggleNavItem,
    applyPreset,
    reset,
  } = useTheme();
  const { notify } = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const mode = theme.ui?.mode ?? 'system';
  const wallpaper = theme.ui?.wallpaper ?? {};
  const hidden = theme.hiddenNav ?? [];
  const radius = theme.ui?.radius ?? 'soft';
  const motion = theme.ui?.motion ?? 'full';
  const font = theme.ui?.font ?? 'sans';
  const glassEnabled = theme.ui?.glass !== false;
  const glassBlur = theme.ui?.glassBlur ?? 18;

  const [title, setTitle] = useState(theme.brand?.title ?? '');
  const [subtitle, setSubtitle] = useState(theme.brand?.subtitle ?? '');
  const [blur, setBlur] = useState(Number(wallpaper.blur ?? 0));
  const [dim, setDim] = useState(Number(wallpaper.dim ?? 0));

  useEffect(() => {
    setTitle(theme.brand?.title ?? '');
    setSubtitle(theme.brand?.subtitle ?? '');
  }, [theme.brand?.title, theme.brand?.subtitle]);

  useEffect(() => {
    setPalette([]);
  }, [wallpaper.url]);

  useEffect(() => {
    setBlur(Number(theme.ui?.wallpaper?.blur ?? 0));
    setDim(Number(theme.ui?.wallpaper?.dim ?? 0));
  }, [theme.ui?.wallpaper?.blur, theme.ui?.wallpaper?.dim, theme.ui?.wallpaper?.url]);

  const [palette, setPalette] = useState<SampledColor[]>([]);
  const [sampling, setSampling] = useState(false);

  /** Pull a palette out of the current wallpaper and keep the usable accents. */
  const runSampling = useCallback(async () => {
    if (!wallpaper.url) return;
    setSampling(true);
    try {
      const colors = await extractPalette(wallpaper.url, 6);
      if (colors.length === 0) {
        setPalette([]);
        notify('这张图里没有提取到可用的色彩', 'error');
        return;
      }
      setPalette(colors);
      notify(`提取到 ${accentCandidates(colors).length} 个可用颜色`, 'success');
    } catch (error) {
      setPalette([]);
      notify(error instanceof Error ? error.message : '取色失败', 'error');
    } finally {
      setSampling(false);
    }
  }, [wallpaper.url, notify]);
  const pickWallpaper = (file: File | undefined) => {
    if (!file) return;
    if (file.size > 8 * 1024 * 1024) {
      notify('图片不能超过 8 MB', 'error');
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      setWallpaper({ url: String(reader.result), blur, dim });
      notify('背景已应用', 'success');
    };
    reader.onerror = () => notify('图片读取失败', 'error');
    reader.readAsDataURL(file);
  };

  const modes: { id: 'light' | 'dark' | 'system'; label: string; icon: typeof Sun }[] = [
    { id: 'light', label: '浅色', icon: Sun },
    { id: 'dark', label: '深色', icon: Moon },
    { id: 'system', label: '跟随系统', icon: Monitor },
  ];

  return (
    <>
      <div className="grid gap-3 lg:grid-cols-[1fr_320px]">
        <div className="flex flex-col gap-3">
          {/* ---------- presets ---------- */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Sparkles className="size-3.5 text-primary" /> 预设风格
              </CardTitle>
              <CardDescription>一键套用配色、字体与圆角的组合，之后仍可单独微调。</CardDescription>
            </CardHeader>
            <CardContent>
              <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
                {PRESETS.map((preset) => {
                  const active = theme.preset === preset.id;
                  const [page, accent, panel] = preset.swatch;
                  return (
                    <button
                      key={preset.id}
                      type="button"
                      onClick={() => {
                        applyPreset(preset.id);
                        notify(`已套用「${preset.name}」`, 'success');
                      }}
                      className={cn(
                        'group relative overflow-hidden rounded-lg border p-2.5 text-left',
                        'transition-[border-color,transform,box-shadow] duration-200 hover:-translate-y-0.5 hover:shadow-card',
                        active ? 'border-[var(--accent-line)] ring-1 ring-[var(--accent-line)]' : 'border-border',
                      )}
                    >
                      {/* miniature skin preview */}
                      <div
                        className="mb-2 flex h-12 items-stretch gap-1 overflow-hidden rounded-md border border-black/5 p-1"
                        style={{ background: page }}
                      >
                        <div className="w-3 rounded-sm" style={{ background: panel }} />
                        <div className="flex flex-1 flex-col justify-center gap-1">
                          <div className="h-1.5 w-8 rounded-full" style={{ background: accent }} />
                          <div className="h-1 w-10 rounded-full opacity-40" style={{ background: accent }} />
                        </div>
                        <div className="w-4 rounded-sm" style={{ background: panel }} />
                      </div>
                      <div className="flex items-center gap-1.5">
                        <span className="text-[12.5px] font-medium">{preset.name}</span>
                        {active ? <Check className="size-3 text-primary" /> : null}
                      </div>
                      <p className="mt-0.5 text-[10.5px] leading-snug text-muted-foreground">{preset.hint}</p>
                    </button>
                  );
                })}
              </div>
            </CardContent>
          </Card>

          {/* ---------- mode + accent ---------- */}
          <Card>
            <CardHeader>
              <CardTitle>主题与强调色</CardTitle>
              <CardDescription>切换时会从点击位置做圆形揭示过渡。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <div className="flex flex-wrap gap-2">
                {modes.map((item) => {
                  const Icon = item.icon;
                  const active = mode === item.id;
                  return (
                    <button
                      key={item.id}
                      type="button"
                      onClick={(event) => setMode(item.id, { clientX: event.clientX, clientY: event.clientY })}
                      className={cn(
                        'inline-flex items-center gap-1.5 rounded-lg border px-3 py-2 text-xs transition-colors',
                        active
                          ? 'border-[var(--accent-line)] bg-[var(--accent-soft)] font-medium text-primary'
                          : 'border-border text-muted-foreground hover:bg-accent',
                      )}
                    >
                      <Icon className="size-3.5" />
                      {item.label}
                    </button>
                  );
                })}
              </div>

              <div>
                <div className="mb-2 text-[12px] font-medium text-foreground/85">
                  强调色 {theme.ui?.primary ? <span className="text-muted-foreground">· {theme.ui.primary}</span> : null}
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  {APP_CONFIG.accentPresets.map((color) => (
                    <button
                      key={color}
                      type="button"
                      onClick={() => setAccent(color)}
                      aria-label={`使用 ${color}`}
                      className={cn(
                        'grid size-8 place-items-center rounded-full border border-border',
                        'transition-transform duration-200 hover:scale-110 active:scale-95',
                      )}
                      style={{ background: color }}
                    >
                      {theme.ui?.primary === color ? <Check className="size-4 text-white" /> : null}
                    </button>
                  ))}
                  <span className="mx-1 h-5 w-px bg-border" />
                  <input
                    type="color"
                    value={theme.ui?.primary || '#0ea5e9'}
                    onChange={(event) => setAccent(event.target.value)}
                    aria-label="自定义颜色"
                    className="size-8 cursor-pointer rounded-full border border-border bg-transparent p-0.5"
                  />
                  <Button variant="ghost" size="sm" onClick={() => setAccent('')}>
                    恢复默认
                  </Button>
                </div>
              </div>

              <div className="flex items-center justify-between rounded-lg border border-border px-3 py-2">
                <div>
                  <div className="flex items-center gap-1.5 text-[13px] font-medium">
                    <Wand2 className="size-3.5 text-primary" /> 渐变强调
                  </div>
                  <div className="text-[11.5px] text-muted-foreground">主按钮与激活项使用双色渐变</div>
                </div>
                <ToggleSwitch
                  value={theme.ui?.gradient === true}
                  onChange={setGradient}
                  ariaLabel="渐变强调"
                />
              </div>
            </CardContent>
          </Card>

          {/* ---------- typography + shape ---------- */}
          <Card>
            <CardHeader>
              <CardTitle className="flex items-center gap-1.5">
                <Type className="size-3.5 text-primary" /> 字体与形状
              </CardTitle>
              <CardDescription>影响全站排版与所有圆角。</CardDescription>
            </CardHeader>
            <CardContent className="grid gap-4 sm:grid-cols-2">
              <Segmented
                label="字体"
                value={font}
                options={[
                  { id: 'sans', label: '无衬线' },
                  { id: 'serif', label: '衬线' },
                  { id: 'mono', label: '等宽' },
                ]}
                onChange={(next) => setFont(next as FontPref)}
              />
              <Segmented
                label="圆角"
                value={radius}
                options={[
                  { id: 'sharp', label: '直角' },
                  { id: 'soft', label: '柔和' },
                  { id: 'round', label: '圆润' },
                ]}
                onChange={(next) => setRadius(next as RadiusPref)}
              />
              <div className="sm:col-span-2">
                <Segmented
                  label="动效强度"
                  value={motion}
                  options={[
                    { id: 'full', label: '完整' },
                    { id: 'subtle', label: '轻微' },
                    { id: 'off', label: '关闭' },
                  ]}
                  onChange={(next) => setMotion(next as MotionPref)}
                  hint="关闭后所有过渡与页面切换动画都会立即完成。"
                />
              </div>
            </CardContent>
          </Card>

          {/* ---------- brand ---------- */}
          <Card>
            <CardHeader>
              <CardTitle>品牌</CardTitle>
              <CardDescription>显示在侧边栏、登录页与浏览器标题。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="grid gap-3 sm:grid-cols-2">
                <Field label="名称">
                  <Input value={title} onChange={(event) => setTitle(event.target.value)} placeholder="Console" />
                </Field>
                <Field label="副标题">
                  <Input
                    value={subtitle}
                    onChange={(event) => setSubtitle(event.target.value)}
                    placeholder="Interface Template"
                  />
                </Field>
              </div>
              <div>
                <Button size="sm" onClick={() => setBrand({ title, subtitle })}>
                  应用
                </Button>
              </div>
            </CardContent>
          </Card>

          {/* ---------- wallpaper ---------- */}
          <Card>
            <CardHeader>
              <CardTitle>背景</CardTitle>
              <CardDescription>上传图片作为全屏背景，可调节模糊与暗化。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-3">
              <div className="flex flex-wrap items-center gap-2">
                <input
                  ref={fileInput}
                  type="file"
                  accept="image/*"
                  className="hidden"
                  onChange={(event) => pickWallpaper(event.target.files?.[0])}
                />
                <Button variant="outline" size="sm" onClick={() => fileInput.current?.click()}>
                  <Upload className="size-3.5" /> 上传图片
                </Button>
                {wallpaper.url ? (
                  <Button
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      setWallpaper({ blur, dim });
                      notify('背景已移除', 'success');
                    }}
                  >
                    <Trash2 className="size-3.5" /> 移除
                  </Button>
                ) : (
                  <span className="inline-flex items-center gap-1 text-[11.5px] text-muted-foreground">
                    <ImageIcon className="size-3.5" /> 尚未设置
                  </span>
                )}
              </div>

              <Field label={`模糊：${blur}px`}>
                <Slider
                  value={blur}
                  min={0}
                  max={18}
                  ariaLabel="背景模糊度"
                  onChange={setBlur}
                  onCommit={() => setWallpaper({ ...wallpaper, blur, dim })}
                />
              </Field>
              <Field label={`暗化：${dim}%`}>
                <Slider
                  value={dim}
                  min={0}
                  max={80}
                  ariaLabel="背景暗化程度"
                  onChange={setDim}
                  onCommit={() => setWallpaper({ ...wallpaper, blur, dim })}
                />
              </Field>

              <div className="rounded-lg border border-border px-3 py-2">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="flex items-center gap-1.5 text-[13px] font-medium">
                      <Contrast className="size-3.5 text-primary" /> 毛玻璃
                    </div>
                    <div className="text-[11.5px] text-muted-foreground">仅在设置背景后可见</div>
                  </div>
                  <ToggleSwitch
                    value={theme.ui?.glass !== false}
                    onChange={setGlass}
                    ariaLabel="毛玻璃效果"
                    disabled={!wallpaper.url}
                  />
                </div>

                {/* Blur radius. Disabled with glass off or no wallpaper, since
                    neither state renders the effect. */}
                <div className={cn('mt-2.5 border-t border-border/60 pt-2.5', !glassEnabled && 'opacity-50')}>
                  <div className="mb-1 flex items-center justify-between">
                    <span className="text-[11.5px] font-medium text-foreground/85">
                      模糊度：{glassBlur}px
                    </span>
                    <span className="text-[10.5px] text-muted-foreground">
                      {glassBlur === 0 ? '无模糊' : glassBlur <= 8 ? '轻微' : glassBlur <= 24 ? '标准' : '强'}
                    </span>
                  </div>
                  <Slider
                    value={glassBlur}
                    min={GLASS_BLUR_MIN}
                    max={GLASS_BLUR_MAX}
                    disabled={!glassEnabled || !wallpaper.url}
                    ariaLabel="毛玻璃模糊度"
                    onChange={setGlassBlur}
                    formatValue={(v) => `${v} 像素`}
                  />
                  <p className="mt-1 text-[10.5px] leading-relaxed text-muted-foreground">
                    模糊越高，面板会自动略微提高不透明度，避免文字被背景吃掉。
                  </p>
                </div>
              </div>

              {/* ---------- Monet palette extraction ---------- */}
              <div className="rounded-lg border border-border px-3 py-2.5">
                <div className="flex items-start justify-between gap-3">
                  <div className="min-w-0">
                    <div className="flex items-center gap-1.5 text-[13px] font-medium">
                      <Pipette className="size-3.5 text-primary" /> 莫奈取色
                    </div>
                    <div className="text-[11.5px] leading-relaxed text-muted-foreground">
                      从背景图中提取主色调，一键应用为强调色
                    </div>
                  </div>
                  <Button
                    variant="outline"
                    size="sm"
                    disabled={!wallpaper.url || sampling}
                    onClick={runSampling}
                  >
                    {sampling ? <Loader2 className="size-3.5 animate-spin" /> : <Wand2 className="size-3.5" />}
                    {sampling ? '提取中' : '提取'}
                  </Button>
                </div>

                {palette.length > 0 ? (
                  <div className="mt-3">
                    <div className="mb-1.5 flex items-center justify-between">
                      <span className="text-[11px] text-muted-foreground">
                        点击色块应用 · 按画面占比排序
                      </span>
                      <button
                        type="button"
                        onClick={() => {
                          const best = palette[0];
                          if (!best) return;
                          const accent = asAccent(best);
                          setAccent(accent);
                          setGradient(true);
                          notify('已应用主色并开启渐变', 'success');
                        }}
                        className="text-[11px] text-primary underline-offset-4 hover:underline"
                      >
                        用主色 + 渐变
                      </button>
                    </div>
                    <div className="flex flex-wrap gap-1.5">
                      {palette.map((color) => {
                        const accent = asAccent(color);
                        const activeColor = theme.ui?.primary === accent;
                        return (
                          <button
                            key={color.hex}
                            type="button"
                            title={`${color.hex} · 占比 ${(color.weight * 100).toFixed(0)}%`}
                            aria-label={`应用颜色 ${accent}`}
                            onClick={() => {
                              setAccent(accent);
                              notify(`已应用 ${accent}`, 'success');
                            }}
                            className={cn(
                              'group relative grid h-9 flex-1 min-w-9 place-items-center rounded-md border transition-transform duration-200 hover:-translate-y-0.5 hover:shadow-card',
                              activeColor ? 'border-primary ring-1 ring-primary' : 'border-border',
                            )}
                            style={{ background: accent }}
                          >
                            {activeColor ? <Check className="size-3.5 text-white" /> : null}
                            {/*占比条：让“这个颜色在画面里有多少”可见*/}
                            <span
                              className="absolute inset-x-0 bottom-0 rounded-b-md bg-black/25"
                              style={{ height: `${Math.max(2, color.weight * 100 * 0.4)}px` }}
                            />
                          </button>
                        );
                      })}
                    </div>
                  </div>
                ) : null}

                {palette.length === 0 && wallpaper.url && !sampling ? (
                  <p className="mt-2 text-[11px] leading-relaxed text-muted-foreground">
                    点击「提取」分析当前背景图。远程图片若不支持跨域读取，将无法取色，请改用本地上传。
                  </p>
                ) : null}
              </div>
            </CardContent>
          </Card>

          {/* ---------- nav visibility ---------- */}
          <Card>
            <CardHeader>
              <CardTitle>侧边栏条目</CardTitle>
              <CardDescription>取消勾选可在导航中隐藏该页（页面本身仍可访问）。</CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-1">
              {NAV.flatMap((group) => group.items).map((item) => {
                const Icon = item.icon;
                const visible = !hidden.includes(item.id);
                return (
                  <div
                    key={item.id}
                    className="flex items-center justify-between rounded-md px-1.5 py-1.5 transition-colors hover:bg-accent/40"
                  >
                    <span className="flex items-center gap-2 text-[13px]">
                      <Icon className="size-3.5 text-muted-foreground" />
                      {item.label}
                    </span>
                    <ToggleSwitch
                      value={visible}
                      onChange={() => toggleNavItem(item.id)}
                      ariaLabel={`显示 ${item.label}`}
                    />
                  </div>
                );
              })}
            </CardContent>
          </Card>
        </div>

        {/* ---------- sticky preview column ---------- */}
        <div className="flex flex-col gap-3 lg:sticky lg:top-[68px] lg:self-start">
          <Preview />
          <Card>
            <CardContent className="flex flex-col gap-2">
              <Button
                variant="outline"
                onClick={() => {
                  reset();
                  notify('已恢复默认外观', 'success');
                }}
              >
                <RotateCcw className="size-3.5" /> 恢复默认
              </Button>
              <p className="text-[11px] leading-relaxed text-muted-foreground">
                所有外观设置保存在浏览器 localStorage，不会上传。接入后端时替换 ThemeProvider 的 storage 适配器即可。
              </p>
            </CardContent>
          </Card>
        </div>
      </div>
    </>
  );
}

/**
 * Label + horizontally laid out options.
 *
 * Used for the three-way preference rows; the selected pill uses a shared
 * layoutId so the highlight slides between options.
 */
function Segmented({
  label,
  value,
  options,
  onChange,
  hint,
}: {
  label: string;
  value: string;
  options: { id: string; label: string }[];
  onChange: (next: string) => void;
  hint?: string;
}) {
  return (
    <div>
      <div className="mb-1.5 text-[12px] font-medium text-foreground/85">{label}</div>
      <div className="inline-flex rounded-lg border border-border bg-muted/40 p-0.5">
        {options.map((option) => {
          const active = value === option.id;
          return (
            <button
              key={option.id}
              type="button"
              onClick={() => onChange(option.id)}
              className={cn(
                'relative rounded-md px-3 py-1.5 text-[12px] transition-colors duration-200',
                active ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
              )}
            >
              {active ? (
                <motion.span
                  layoutId={`seg-${label}`}
                  className="absolute inset-0 rounded-md bg-card shadow-xs"
                  transition={{ type: 'spring', stiffness: 400, damping: 32 }}
                />
              ) : null}
              <span className="relative">{option.label}</span>
            </button>
          );
        })}
      </div>
      {hint ? <p className="mt-1.5 text-[11px] leading-relaxed text-muted-foreground">{hint}</p> : null}
    </div>
  );
}

/** Compact schematic preview of the shell, updated live by the theme. */
function Preview() {
  const { theme, isDark } = useTheme();
  const accent = theme.ui?.primary || '#0ea5e9';
  const wallpaper = theme.ui?.wallpaper;
  const gradient = theme.ui?.gradient === true;
  const radius =
    theme.ui?.radius === 'sharp' ? '2px' : theme.ui?.radius === 'round' ? '12px' : '7px';
  const bg = isDark ? '#0b1116' : '#f7f9fb';
  const panel = isDark ? '#121a21' : '#ffffff';
  const line = isDark ? 'rgba(255,255,255,.08)' : 'rgba(15,23,42,.08)';
  const text = isDark ? 'rgba(255,255,255,.82)' : 'rgba(15,23,42,.82)';
  const blurred = Math.min(Number(wallpaper?.blur) || 0, 18);
  const dim = (Number(wallpaper?.dim) || 0) / 100;

  const accentFill = gradient ? `linear-gradient(135deg, ${accent}, ${accent}99)` : accent;

  return (
    <Card className="overflow-hidden p-2">
      <div
        className="relative overflow-hidden border"
        style={{ borderColor: line, background: bg, height: 216, borderRadius: radius }}
      >
        {wallpaper?.url ? (
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: `url(${wallpaper.url})`,
              backgroundSize: 'cover',
              backgroundPosition: 'center',
              filter: `blur(${blurred}px)`,
            }}
          />
        ) : null}
        {dim > 0 ? <div className="absolute inset-0" style={{ background: `rgba(0,0,0,${dim})` }} /> : null}
        <div className="relative flex h-full">
          <div
            className="flex w-[78px] flex-col gap-1.5 border-r p-2"
            style={{ borderColor: line, background: panel, opacity: wallpaper?.url ? 0.94 : 1 }}
          >
            <div className="flex items-center gap-1.5">
              <div className="size-4 rounded" style={{ background: accentFill, borderRadius: radius }} />
              <div className="truncate text-[7px] font-semibold" style={{ color: text }}>
                {theme.brand?.title || 'Aneko'}
              </div>
            </div>
            <div className="mt-1 space-y-1">
              {['仪表盘', '组件', '数据', '外观'].map((item, index) => (
                <div
                  key={item}
                  className="truncate px-1 py-[3px] text-[6.5px]"
                  style={
                    index === 1
                      ? { background: `${accent}26`, color: accent, borderRadius: radius }
                      : { color: text, opacity: 0.75 }
                  }
                >
                  {item}
                </div>
              ))}
            </div>
          </div>
          <div className="flex-1 p-2.5">
            <div className="mb-2 flex items-center justify-between">
              <div className="text-[8px] font-semibold" style={{ color: text }}>
                {theme.brand?.subtitle || 'Interface Template'}
              </div>
            </div>
            <div className="grid grid-cols-3 gap-1.5">
              {[0, 1, 2].map((index) => (
                <div
                  key={index}
                  className="p-1.5"
                  style={{ background: panel, border: `1px solid ${line}`, borderRadius: radius }}
                >
                  <div
                    className="h-1.5 w-6 rounded"
                    style={{ background: index === 1 ? accentFill : line }}
                  />
                  <div className="mt-1 h-1 w-8 rounded" style={{ background: line }} />
                </div>
              ))}
            </div>
            <div
              className="mt-2 p-2"
              style={{ background: panel, border: `1px solid ${line}`, borderRadius: radius }}
            >
              <div className="h-1.5 w-14 rounded" style={{ background: accentFill }} />
              <div className="mt-1.5 space-y-1">
                {[0, 1, 2].map((index) => (
                  <div
                    key={index}
                    className="h-1 rounded"
                    style={{ background: line, width: `${72 - index * 14}%` }}
                  />
                ))}
              </div>
            </div>
          </div>
        </div>
      </div>
    </Card>
  );
}
