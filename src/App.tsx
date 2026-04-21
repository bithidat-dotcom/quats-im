import React, { useState, useCallback, useRef } from 'react';
import { useDropzone } from 'react-dropzone';
import { motion, AnimatePresence } from 'framer-motion';
import { Upload, Image as ImageIcon, Settings, Sparkles, Download, X, Key, Wand2, Loader2, Check } from 'lucide-react';
import toast, { Toaster } from 'react-hot-toast';
import { GoogleGenAI } from '@google/genai';
import { cn } from './lib/utils';

// Types
type Ratio = '1:1' | '16:9' | '9:16' | '21:9' | '4:3';
type Style = 'None' | 'Photorealistic' | 'Anime' | 'Cyberpunk' | 'Cinematic' | '3D Render' | 'Digital Art' | 'Watercolor' | 'Sketch';
type Quality = 'Standard' | 'High' | 'Ultra';

interface AppState {
  prompt: string;
  image: File | null;
  imagePreview: string | null;
  apiKey: string;
  apiBaseUrl: string;
  apiModel: string;
  apiConnected: boolean;
  showAdvancedAPI: boolean;
  ratio: Ratio;
  style: Style;
  quality: Quality;
  sharpness: number;
}

const RATIOS: { label: Ratio; w: number; h: number; dallESize: string }[] = [
  { label: '1:1', w: 1024, h: 1024, dallESize: '1024x1024' },
  { label: '16:9', w: 1280, h: 720, dallESize: '1792x1024' },
  { label: '9:16', w: 720, h: 1280, dallESize: '1024x1792' },
  { label: '4:3', w: 1024, h: 768, dallESize: '1024x1024' },
];

const STYLES: Style[] = ['None', 'Photorealistic', 'Anime', 'Cyberpunk', 'Cinematic', '3D Render', 'Digital Art', 'Watercolor'];
const QUALITIES: Quality[] = ['Standard', 'High', 'Ultra'];

export default function App() {
  const [state, setState] = useState<AppState>({
    prompt: '',
    image: null,
    imagePreview: null,
    apiKey: '',
    apiBaseUrl: 'https://api.openai.com/v1',
    apiModel: 'dall-e-3',
    apiConnected: false,
    showAdvancedAPI: false,
    ratio: '1:1',
    style: 'None',
    quality: 'High',
    sharpness: 50,
  });

  const [isGenerating, setIsGenerating] = useState(false);
  const [generatedImage, setGeneratedImage] = useState<string | null>(null);
  const [showSettings, setShowSettings] = useState(false);

  const onDrop = useCallback((acceptedFiles: File[]) => {
    const file = acceptedFiles[0];
    if (file) {
      if (file.size > 5 * 1024 * 1024) {
        toast.error('Image must be less than 5MB');
        return;
      }
      setState(s => ({
        ...s,
        image: file,
        imagePreview: URL.createObjectURL(file)
      }));
    }
  }, []);

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'image/*': [] },
    maxFiles: 1,
    multiple: false
  } as any);

  const removeImage = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (state.imagePreview) {
      URL.revokeObjectURL(state.imagePreview);
    }
    setState(s => ({ ...s, image: null, imagePreview: null }));
  };

  const fileToBase64 = (file: File): Promise<string> => {
    return new Promise((resolve, reject) => {
      const reader = new FileReader();
      reader.readAsDataURL(file);
      reader.onload = () => {
        if (typeof reader.result === 'string') {
          // Remove the data:image/[type];base64, prefix for Gemini
          resolve(reader.result.split(',')[1]);
        } else {
          reject(new Error('Failed to read file'));
        }
      };
      reader.onerror = error => reject(error);
    });
  };

  const handleConnectApi = async () => {
    if (!state.apiKey) {
      toast.error('Please enter an API Key first');
      return;
    }
    
    toast.loading('Verifying connection...', { id: 'api-connect' });
    
    try {
      const baseUrl = state.apiBaseUrl.replace(/\/+$/, '');
      const testUrl = baseUrl.endsWith('/images/generations') 
        ? baseUrl.replace('/images/generations', '/models') 
        : `${baseUrl}/models`;

      const res = await fetch(testUrl, {
        method: 'GET',
        headers: { 'Authorization': `Bearer ${state.apiKey}` }
      });

      if (!res.ok) {
         const errorData = await res.json().catch(() => ({}));
         if (res.status === 401 || errorData.error?.code === 'invalid_api_key') {
           setState(s => ({ ...s, apiConnected: false }));
           toast.error('Invalid API Key. Please check your credentials.', { id: 'api-connect' });
           return;
         }
      }
      
      setState(s => ({ ...s, apiConnected: true }));
      toast.success('Successfully connected to AI provider!', { id: 'api-connect' });
    } catch (e) {
      // CORS or network error, fallback to blind assumption since many custom providers don't have standard /models CORS
      setState(s => ({ ...s, apiConnected: true }));
      toast.success('Connected (verifications skipped)', { id: 'api-connect' });
    }
  };

  const generateCustomAPIImage = async (prompt: string, key: string, size: string, width: number, height: number) => {
    const baseUrl = state.apiBaseUrl.replace(/\/+$/, '');
    const url = baseUrl.endsWith('/images/generations') ? baseUrl : `${baseUrl}/images/generations`;

    const isDalle = state.apiModel.includes('dall-e');
    const payload: any = {
      model: state.apiModel,
      prompt: prompt,
      n: 1,
    };

    if (isDalle) {
      payload.size = size; // DALL-E only expects 'size' and strictly rejects 'width' and 'height'
    } else {
      payload.width = width;
      payload.height = height;
      payload.size = `${width}x${height}`; // Fallback for some alternate endpoints
    }

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${key}`
      },
      body: JSON.stringify(payload)
    });
    
    if (!response.ok) {
      const errText = await response.text();
      let errMsg = 'Custom API Error';
      try {
         const errObj = JSON.parse(errText);
         errMsg = errObj.error?.message || errObj.message || errText;
      } catch {
         errMsg = errText;
      }
      throw new Error(errMsg);
    }
    
    const data = await response.json();
    return data.data[0].url || data.data[0].b64_json;
  };

  const generateImage = async () => {
    if (!state.prompt && !state.image) {
      toast.error('Please enter a prompt or upload an image to edit.');
      return;
    }

    setIsGenerating(true);
    setGeneratedImage(null);
    let finalPrompt = state.prompt;

    try {
      // Step 1: If there's an image uploaded (Image to Sketch / Image Edit mode)
      // We use Gemini to act as a bridge, describing the image and incorporating instructions
      if (state.image) {
        toast.loading('Analyzing sketch/image with AI...', { id: 'gen' });
        
        const base64Image = await fileToBase64(state.image);
        
        // Use Gemini API automatically exposed via AI Studio
        const ai = new GoogleGenAI({ apiKey: process.env.GEMINI_API_KEY });
        
        const visionPrompt = `
          You are an expert AI image prompt engineer. The user has uploaded an image or sketch.
          They also provided the following instructions: "${state.prompt || 'Convert this sketch into a beautiful, fully realized image'}".
          
          Your goal: Describe the visual contents of the uploaded image in extreme, vivid detail so it can be used as a text-to-image prompt.
          If the user's instructions modify the image (e.g., "make it cyberpunk" or "add a red background"), seamlessly integrate those changes into your description.
          If it's a sketch, describe the fully realized version of what the sketch represents.
          
          Respond ONLY with the final, highly detailed prompt text. No explanations.
        `;

        const response = await ai.models.generateContent({
          model: 'gemini-2.5-flash',
          contents: [
            { role: 'user', parts: [
              { text: visionPrompt },
              { inlineData: { data: base64Image, mimeType: state.image.type } }
            ]}
          ]
        });

        finalPrompt = response.text || finalPrompt;
        console.log("Gemini Generated Prompt:", finalPrompt);
      }

      // Append style instructions
      if (state.style !== 'None') {
        finalPrompt += `, in the style of ${state.style}, highly detailed, masterpiece, best quality`;
      }
      
      // Append sharpness & quality modifiers
      if (state.sharpness > 70) {
        finalPrompt += `, incredibly sharp focus, 8k resolution, highly detailed, crisp`;
      }
      if (state.quality === 'Ultra') {
        finalPrompt += `, ultra-high definition, award winning photography, trending on artstation`;
      }

      toast.loading('Generating your masterpiece...', { id: 'gen' });

      const selectedRatio = RATIOS.find(r => r.label === state.ratio) || RATIOS[0];
      const width = selectedRatio.w;
      const height = selectedRatio.h;
      
      let imageUrl = '';

      // Step 2: Generate via Custom API if key is provided, otherwise Pollinations (Free)
      if (state.apiKey) {
         // Custom AI API provided
         imageUrl = await generateCustomAPIImage(finalPrompt, state.apiKey, selectedRatio.dallESize, width, height);
      } else {
        // Free Pollinations API
        // Add random seed to avoid caching
        const seed = Math.floor(Math.random() * 1000000);
        const encodedPrompt = encodeURIComponent(finalPrompt);
        imageUrl = `https://image.pollinations.ai/prompt/${encodedPrompt}?width=${width}&height=${height}&seed=${seed}&nologo=true&enhance=${state.quality === 'Ultra' ? 'true' : 'false'}`;
        
        // Pre-fetch the image to ensure it's loaded before we show it, avoiding broken image flicker
        await new Promise((resolve, reject) => {
          const img = new Image();
          img.onload = resolve;
          img.onerror = () => reject(new Error('Failed to load image from Pollinations.'));
          img.src = imageUrl;
        });
      }

      setGeneratedImage(imageUrl);
      toast.success('Image generated successfully!', { id: 'gen' });

    } catch (error: any) {
      console.error(error);
      toast.error(error.message || 'Failed to generate image', { id: 'gen' });
    } finally {
      setIsGenerating(false);
    }
  };

  const handleDownload = async () => {
    if (!generatedImage) return;
    try {
      const response = await fetch(generatedImage);
      const blob = await response.blob();
      const url = window.URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `quats-image-${Date.now()}.png`;
      document.body.appendChild(a);
      a.click();
      window.URL.revokeObjectURL(url);
      document.body.removeChild(a);
    } catch (err) {
      toast.error('Failed to download image. You can right-click and save it instead.');
    }
  };

  return (
    <div className="flex h-screen w-full p-6 gap-6 relative overflow-hidden bg-[#050505] text-[#E5E7EB] font-sans">
      <Toaster position="top-center" toastOptions={{
        style: { background: 'rgba(20,20,20,0.8)', color: '#fff', border: '1px solid rgba(255,255,255,0.1)', backdropFilter: 'blur(10px)' },
        success: { iconTheme: { primary: '#00FF41', secondary: '#000' } }
      }} />

      {/* Decorative background gradients */}
      <div className="fixed inset-0 pointer-events-none z-0 flex justify-center items-center overflow-hidden">
        <div className="absolute top-[-20%] left-[-10%] w-[50vw] h-[50vw] bg-[#00FF41]/10 rounded-full blur-[120px] opacity-30 mix-blend-screen" />
        <div className="absolute bottom-[-20%] right-[-10%] w-[40vw] h-[40vw] bg-[#008F23]/10 rounded-full blur-[100px] opacity-20 mix-blend-screen" />
      </div>

      {/* Sidebar */}
      <aside className="w-72 flex flex-col gap-4 z-10 overflow-y-auto custom-scrollbar pr-2 pb-4">
        {/* Header */}
        <div className="flex items-center gap-3 mb-2 shrink-0">
          <div className="w-10 h-10 bg-neo-green rounded-lg flex items-center justify-center">
            <Sparkles className="w-6 h-6 text-black" />
          </div>
          <h1 className="text-2xl font-black tracking-tighter italic whitespace-nowrap">
            QUATS <span className="neo-green">IMAGE</span>
          </h1>
        </div>

        {/* Settings Glass Panel */}
        <div className="glass p-4 flex flex-col gap-5 shrink-0">
          
          {/* API Key */}
          <div className="space-y-2">
            <label className="text-[10px] uppercase tracking-widest text-gray-500 font-bold flex items-center justify-between">
              <span>API Slot</span>
              <Key className="w-3 h-3" />
            </label>
            <input
              type="password"
              placeholder="Paste Custom API Key..."
              value={state.apiKey}
              onChange={e => {
                setState(s => ({ ...s, apiKey: e.target.value }));
                if (state.apiConnected && !e.target.value) setState(s => ({ ...s, apiConnected: false }));
              }}
              className="w-full bg-black/40 border border-white/10 rounded-lg p-2 text-xs focus:ring-1 focus:ring-neo-green transition-all"
            />
            {state.showAdvancedAPI && (
              <motion.div initial={{ opacity: 0, height: 0 }} animate={{ opacity: 1, height: 'auto' }} className="space-y-2 mt-2">
                <input
                  type="text"
                  placeholder="Base URL (e.g. https://api.openai.com/v1)"
                  value={state.apiBaseUrl}
                  onChange={e => setState(s => ({ ...s, apiBaseUrl: e.target.value }))}
                  className="w-full bg-black/40 border border-white/10 rounded-lg p-2 text-[10px] focus:ring-1 focus:ring-neo-green transition-all"
                />
                <input
                  type="text"
                  placeholder="Model (e.g. dall-e-3)"
                  value={state.apiModel}
                  onChange={e => setState(s => ({ ...s, apiModel: e.target.value }))}
                  className="w-full bg-black/40 border border-white/10 rounded-lg p-2 text-[10px] focus:ring-1 focus:ring-neo-green transition-all"
                />
              </motion.div>
            )}
            <div className="flex items-center justify-between pt-1">
               <button 
                 onClick={() => setState(s => ({ ...s, showAdvancedAPI: !s.showAdvancedAPI }))}
                 className="text-[9px] text-gray-500 hover:text-white transition-colors"
               >
                 {state.showAdvancedAPI ? 'Hide Advanced' : '+ Custom Integration'}
               </button>
               <button
                 onClick={handleConnectApi}
                 className={cn("px-3 py-1 rounded text-[10px] font-bold border transition-all flex items-center justify-center min-w-[70px]", state.apiConnected ? "bg-neo-green/20 border-neo-green text-neo-green" : "bg-white/10 border-white/20 hover:border-neo-green text-white")}
               >
                 {state.apiConnected ? <span className="flex items-center gap-1"><Check className="w-3 h-3"/> Connected</span> : 'Connect'}
               </button>
            </div>
          </div>

          {/* Ratio */}
          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Ratio</label>
            <div className="grid grid-cols-2 gap-2">
              {RATIOS.map(ratio => (
                <button
                  key={ratio.label}
                  onClick={() => setState(s => ({ ...s, ratio: ratio.label }))}
                  className={cn(
                    "text-[10px] py-1.5 rounded transition-all",
                    state.ratio === ratio.label 
                      ? "bg-white/10 border border-neo-green text-white" 
                      : "bg-white/5 border border-white/10 text-gray-400 hover:border-neo-green/50"
                  )}
                >
                  {ratio.label}
                </button>
              ))}
            </div>
          </div>

          {/* Quality */}
          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Quality</label>
            <div className="grid grid-cols-1 gap-2">
               <select 
                 value={state.quality}
                 onChange={(e) => setState(s => ({ ...s, quality: e.target.value as Quality }))}
                 className="w-full bg-black/40 border border-white/10 rounded-lg p-2 text-xs appearance-none custom-scrollbar outline-none focus:border-neo-green"
               >
                 {QUALITIES.map(q => (
                   <option key={q} value={q}>{q}</option>
                 ))}
               </select>
            </div>
          </div>

          {/* Style */}
          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-widest text-gray-500 font-bold">Style Preset</label>
            <div className="grid grid-cols-2 gap-2">
              {STYLES.filter(s => s !== 'None').map(style => (
                <button
                  key={style}
                  onClick={() => setState(s => ({ ...s, style }))}
                  className={cn(
                    "text-[10px] py-2 px-2 rounded text-left transition-all truncate",
                    state.style === style
                      ? "bg-white/10 border border-neo-green text-white"
                      : "bg-white/5 border border-white/10 text-gray-400 hover:border-neo-green/50"
                  )}
                >
                  {style}
                </button>
              ))}
            </div>
          </div>

          {/* Sharpness (Instead of a separate section, embed it cleanly) */}
          <div className="space-y-1">
            <label className="text-[10px] uppercase tracking-widest text-gray-500 font-bold flex justify-between">
              <span>Sharpness</span>
              <span className="neo-green">{state.sharpness}%</span>
            </label>
            <input 
              type="range" 
              min="0" max="100" 
              value={state.sharpness}
              onChange={e => setState(s => ({ ...s, sharpness: parseInt(e.target.value) }))}
              className="w-full h-1 bg-white/10 rounded-full appearance-none outline-none cursor-pointer"
              style={{
                background: `linear-gradient(to right, #00FF41 ${state.sharpness}%, rgba(255,255,255,0.1) ${state.sharpness}%)`
              }}
            />
          </div>

        </div>

        {/* Image Upload Area added to Sidebar */}
        <div className="glass p-3 flex flex-col gap-2 shrink-0">
          <label className="text-[10px] uppercase tracking-widest text-gray-500 font-bold flex items-center justify-between">
            <span>Base Image / Sketch</span>
            {state.image && <X className="w-3 h-3 cursor-pointer hover:text-red-400" onClick={removeImage} />}
          </label>
          <div 
             {...getRootProps()} 
             className={cn(
               "relative overflow-hidden group cursor-pointer border-2 border-dashed rounded-lg transition-all flex items-center justify-center bg-black/20",
               isDragActive ? "border-neo-green bg-neo-green/5" : "border-white/10 hover:border-neo-green/50",
               state.imagePreview ? "h-32 border-none" : "h-20"
             )}
           >
             <input {...getInputProps()} />
             
             {state.imagePreview ? (
               <img src={state.imagePreview} alt="Preview" className="w-full h-full object-cover" />
             ) : (
               <div className="flex flex-col items-center justify-center text-gray-500 group-hover:text-gray-300">
                 <Upload className="w-4 h-4 mb-1" />
                 <span className="text-[10px]">Upload or Drop</span>
               </div>
             )}
           </div>
        </div>

        {/* System Status Footer */}
        <div className="mt-auto glass p-3 shrink-0">
          <div className="flex items-center justify-between text-[10px] mb-2">
            <span className="text-gray-400">System Status</span>
            <span className="neo-green animate-pulse">● Active</span>
          </div>
          <p className="text-[9px] text-gray-500 leading-relaxed">
            {state.apiConnected ? `Connected to ${state.apiModel} engine.` : "Pollinations AI active. Connect your API for advanced style weights."}
          </p>
        </div>
      </aside>

      {/* Main Area */}
      <main className="flex-1 flex flex-col gap-6 z-10 min-w-0">
        
        {/* Top Tabs Mockup (Visual Only for Theme Completeness) */}
        <div className="flex gap-4 p-1 bg-white/5 rounded-2xl w-max mx-auto shrink-0 hidden md:flex">
          <button className="px-6 py-2 rounded-xl text-xs font-bold bg-white/10 text-white">Image Generator</button>
          <button className="px-6 py-2 rounded-xl text-xs font-bold text-gray-500 hover:text-white">Sketch to Full</button>
          <button className="px-6 py-2 rounded-xl text-xs font-bold text-gray-500 hover:text-white">Style Converter</button>
        </div>

        {/* Results / Preview Area */}
        <div className={cn(
          "flex-1 glass relative group overflow-hidden flex items-center justify-center min-h-0 p-4",
          !generatedImage && !isGenerating && "border-dashed border-2 border-white/10"
        )}>
          <AnimatePresence mode="wait">
            {isGenerating ? (
              <motion.div 
                key="generating"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
                className="flex flex-col items-center gap-4 text-neo-green/80"
              >
                <div className="relative w-16 h-16">
                   <div className="absolute inset-0 border-2 border-neo-green/20 border-t-neo-green rounded-full animate-spin"></div>
                   <div className="absolute inset-2 border-2 border-neo-green/20 border-b-neo-green/80 rounded-full animate-spin flex items-center justify-center" style={{ animationDirection: 'reverse' }}>
                     <Sparkles className="w-4 h-4 text-neo-green animate-pulse" />
                   </div>
                </div>
                <p className="text-xs font-bold tracking-widest uppercase animate-pulse">Synthesizing...</p>
              </motion.div>
            ) : generatedImage ? (
              <motion.div
                key="result"
                initial={{ opacity: 0, scale: 0.95 }}
                animate={{ opacity: 1, scale: 1 }}
                className="w-full h-full relative"
              >
                <img 
                  src={generatedImage} 
                  alt="Generated" 
                  className="w-full h-full object-contain"
                  referrerPolicy="no-referrer"
                />
                <div className="absolute inset-0 bg-gradient-to-t from-black/80 via-transparent to-transparent opacity-0 group-hover:opacity-100 transition-opacity flex flex-col justify-end p-8">
                  <div className="flex gap-4 items-center justify-end">
                    <button 
                      onClick={handleDownload}
                      className="bg-white/10 hover:bg-white/20 p-3 rounded-full backdrop-blur-lg border border-white/20 transition-all hover:border-neo-green"
                      title="Download Image"
                    >
                      <Download className="w-5 h-5 text-white" />
                    </button>
                  </div>
                </div>
              </motion.div>
            ) : (
              <motion.div 
                key="empty"
                initial={{ opacity: 0 }} animate={{ opacity: 1 }}
                className="text-center space-y-4"
              >
                <div className="w-32 h-32 mx-auto border-2 border-dashed border-white/5 rounded-3xl flex items-center justify-center opacity-40">
                  <ImageIcon className="w-12 h-12 text-gray-600" />
                </div>
                <p className="text-gray-500 text-sm italic">Awaiting prompt for creation...</p>
              </motion.div>
            )}
          </AnimatePresence>
        </div>

        {/* Prompt Builder Area */}
        <div className="h-32 glass p-4 flex gap-4 items-end shrink-0">
          <div className="flex-1 space-y-2 h-full flex flex-col">
            <label className="text-[10px] uppercase tracking-widest text-gray-500 font-bold ml-1 shrink-0">Prompt Builder</label>
            <textarea 
              value={state.prompt}
              onChange={e => setState(s => ({ ...s, prompt: e.target.value }))}
              placeholder="Describe your vision... (e.g. A digital sketch of a futuristic city merging into a lush jungle, 8k, cinematic lighting)" 
              className="flex-1 w-full bg-black/20 rounded-xl p-3 text-sm resize-none border border-white/5 focus:border-neo-green transition-all custom-scrollbar"
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  generateImage();
                }
              }}
            />
          </div>
          <button 
            onClick={generateImage}
            disabled={isGenerating}
            className="h-[68px] px-8 bg-neo-green text-black font-black uppercase tracking-tighter text-lg rounded-xl btn-glow flex items-center justify-center gap-2 transition-all active:scale-95 disabled:opacity-50 disabled:cursor-not-allowed shrink-0"
          >
            {isGenerating ? <Loader2 className="w-6 h-6 animate-spin" /> : <Wand2 className="w-6 h-6" />}
            {isGenerating ? 'WORKING' : 'CREATE'}
          </button>
        </div>

      </main>
    </div>
  );
}
