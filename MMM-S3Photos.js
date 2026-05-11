Module.register("MMM-S3Photos", {
    defaults: {
        syncTimeHours: 1, // How often to run the Lambda function and run the delta logic
        cacheLifeDays: 0, // 0 = never clean cache, >0 = days between cache purges
        displayDurationSeconds: 30, // How long (seconds) to display each photo
        transitionDurationSeconds: 2, // How long (seconds) the transition animation takes
        displayStyle: "wallpaper", // Choose one:
                                  // "wallpaper" (fills entire screen)
                                  // "fill" (fills container region)
                                  // "fit-display" (maintains aspect ratio, fills display)
                                  // "absolute" (fixed size)
        absoluteOptions: {
            enabled: false,
            side: "horizontal", // "horizontal" or "vertical"
            size: 400,  // Image will be max 400px wide
            blurContainer: {
                width: 500, // pixels only used if applyBlur and absolute options are enabled.
                height: 500  // pixels
            }
        },
        applyBlur: false, // Apply blur effect to empty space
        displayOrder: "random", // "newest_first", "oldest_first", "random", "random_dedupe"
        video: {
            enabled: true,           // Enable/disable video playback
            autoplay: true,          // Auto-start videos
            muted: true,             // Mute videos (required for autoplay)
            loop: false,             // Loop individual videos
            controls: false,         // Show video controls
            preload: 'metadata',     // Preload strategy ('none', 'metadata', 'auto')
            videosOnly: false        // Show only videos (filter out images)
        },
        attribution: {
            enabled: true,
            attributions: {
                "samples": "Sample Photography"
            },
            position: "static", // "static" or "dynamic"
            corner: "bottom-right", // "top-left", "top-right", "bottom-left", "bottom-right" ignored if position is dynamic
            relativeTo: "display" // "display" or "image"
        },
        selfieUploads: false,  // Whether to process and upload photos from MMM-Selfieshot
        selfieFolder: "selfies" // S3 folder name for selfie uploads
    },

    start: function() {
        Log.info("Starting module: " + this.name);
        this.photos = [];
        this.displayedPhotos = new Set();
        this.cacheDir = 'cache';
        this.loaded = false;
        this.moduleLoaded = false;
        this.sortedPhotos = null;
        this.currentIndex = 0;
        this.imagesDisplayed = 0;

        // Set transition duration from config
        const wrapper = document.getElementById(this.identifier);
        if (wrapper) {
            wrapper.style.setProperty('--transition-duration', `${this.config.transitionDurationSeconds || 2}s`);
        }
    },

    getMediaType: function(key) {
        const ext = key.toLowerCase().split('.').pop();
        const videoExts = ['mp4', 'webm', 'ogg', 'mov', 'avi', 'mkv', 'm4v'];
        const imageExts = ['jpg', 'jpeg', 'png', 'gif', 'webp', 'bmp', 'svg'];
        
        if (videoExts.includes(ext)) return 'video';
        if (imageExts.includes(ext)) return 'image';
        return 'unknown';
    },

    createMediaElements: function() {
        // Create photo elements
        const photoBack = document.createElement("div");
        photoBack.className = "photo-back";
        
        const photoCurrent = document.createElement("div");
        photoCurrent.className = "photo-current";
        
        // Create video element
        const videoCurrent = document.createElement("video");
        videoCurrent.className = "video-current";
        videoCurrent.style.display = "none";
        videoCurrent.preload = this.config.video.preload;
        videoCurrent.muted = this.config.video.muted;
        videoCurrent.controls = this.config.video.controls;
        
        return { photoBack, photoCurrent, videoCurrent };
    },

    notificationReceived: function(notification, payload, sender) {
        if (notification === "ALL_MODULES_STARTED") {
            Log.info(this.name + " received ALL_MODULES_STARTED notification");
            this.moduleLoaded = true;
            this.initialize();
        } else if (notification === "GPHOTO_UPLOAD" && this.config.selfieUploads) {
            Log.info("Received new photo notification:");
            this.sendSocketNotification("NEW_PHOTO", {
                path: payload,
                folder: this.config.selfieFolder
            });
        } else if (notification === "DOM_OBJECTS_CREATED") {
            // Handle initial load
        }
    },

    initialize: function() {
        Log.info(this.name + " initializing...");
        
        // Ensure we have valid configuration
        if (!this.config.syncTimeHours || this.config.syncTimeHours < 1) {
            this.config.syncTimeHours = 1;
        }
        
        this.getPhotos();
        
        // Set up photo rotation timer
        this.scheduleNextPhoto();
        
        // Set up intervals for photo refresh
        setInterval(() => {
            this.getPhotos();
        }, this.config.syncTimeHours * 3600000);

        // Only set up cache cleanup if enabled
        if (this.config.cacheLifeDays > 0) {
            Log.info(this.name + " setting up cache cleanup interval");
            setInterval(() => {
                this.cleanupCache().catch(err => {
                    Log.error("Error during cache cleanup:", err);
                });
            }, this.config.cacheLifeDays * 86400000);
        } else {
            Log.info(this.name + " cache cleanup disabled");
        }
    },

    getPhotos: function() {
        if (!this.moduleLoaded) {
            Log.warn(this.name + " tried to get photos before module was loaded");
            return;
        }
        
        Log.info("Requesting photos from node helper");
        this.sendSocketNotification("GET_PHOTOS", { 
            cacheDir: this.cacheDir,
            moduleName: this.name
        });
    },

    socketNotificationReceived: function(notification, payload) {
        if (!this.moduleLoaded) {
            Log.warn(this.name + " received socket notification before module was loaded");
            return;
        }

        Log.info(this.name + " received socket notification:", notification);
        
        // Only handle PHOTOS_UPDATED and PHOTOS_ERROR notifications here
        // These are display-specific notifications that won't create loops
        switch(notification) {
            case "PHOTOS_UPDATED":
                if (Array.isArray(payload) && payload.length > 0) {
                    Log.info("Received photos array with length:", payload.length);
                    
                    // Filter to videos only if configured
                    if (this.config.video.videosOnly) {
                        this.photos = payload.filter(item => {
                            const mediaType = this.getMediaType(item.key);
                            return mediaType === 'video';
                        });
                        Log.info(`Filtered to ${this.photos.length} videos only`);
                    } else {
                        this.photos = payload;
                    }

                    // Sort photos based on configuration
                    if (this.config.displayOrder === "newest_first") {
                        this.photos.sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
                    } else if (this.config.displayOrder === "oldest_first") {
                        this.photos.sort((a, b) => new Date(a.lastModified) - new Date(b.lastModified));
                    }
                    
                    this.errorMessage = null;
                    this.loaded = true;
                    this.updateDom(0);
                    this.scheduleNextPhoto();
                } else {
                    Log.warn("Received empty or invalid photos array");
                    this.photos = [];
                    this.errorMessage = "No photos available";
                    this.loaded = true;
                    this.updateDom(0);
                }
                break;

            case "PHOTOS_ERROR":
                Log.error("Error received from node helper:", payload);
                this.loaded = true;
                this.errorMessage = typeof payload === 'object' ? 
                    (payload.message || JSON.stringify(payload)) : 
                    (payload || 'Failed to load photos. Check the server logs for details.');
                this.updateDom(0);
                break;
        }
    },

    cleanupCache: async function() {
        try {
            const cacheFile = path.join(this.cacheDir, 'photos.json');
            if (fs.existsSync(cacheFile)) {
                fs.unlinkSync(cacheFile);
            }
            const files = await fs.promises.readdir(this.cacheDir);
            await Promise.all(files.map(file => fs.promises.unlink(path.join(this.cacheDir, file))));
            
            // Trigger sync after cleanup
            Log.info("Cache cleanup complete, triggering photo sync");
            this.getPhotos();
        } catch (err) {
            console.error("Error during cache cleanup: " + err);
        }
    },


    getAttributionText: function(photoUrl) {
        const parts = photoUrl.split('/');
        const subfolder = parts[parts.length - 2] || '';
        return this.config.attribution.attributions[subfolder] || "";
    },

    getDom: function() {
        const wrapper = document.createElement("div");
        wrapper.className = `MMM-S3Photos ${this.config.displayStyle}`;

        // Show a spinner while photos are still being downloaded from S3
        if (!this.loaded) {
            const loading = document.createElement("div");
            loading.className = "s3photos-loading";

            const spinner = document.createElement("div");
            spinner.className = "s3photos-spinner";

            const msg = document.createElement("p");
            msg.className = "s3photos-loading-msg";
            msg.textContent = "Downloading data from S3, this may take some time depending on photo/video volume.";

            loading.appendChild(spinner);
            loading.appendChild(msg);
            wrapper.appendChild(loading);
            return wrapper;
        }

        // Handle absolute sizing
        if (this.config.displayStyle === "absolute" && this.config.absoluteOptions?.enabled) {
            const size = this.config.absoluteOptions.size || 400;
            wrapper.classList.add(this.config.absoluteOptions.side); // Add horizontal/vertical class
            
            // Set CSS custom properties for dimensions
            if (this.config.absoluteOptions.side === "horizontal") {
                wrapper.style.setProperty('--absolute-width', `${size}px`);
            } else {
                wrapper.style.setProperty('--absolute-height', `${size}px`);
            }
            
            // Handle blur container if enabled
            if (this.config.applyBlur) {
                const blurContainer = document.createElement("div");
                blurContainer.className = "blur-enabled";
                
                // Add logging to verify values
                console.log('Blur container config:', this.config.absoluteOptions.blurContainer);
                
                // Set blur container dimensions
                if (this.config.absoluteOptions.blurContainer) {
                    blurContainer.style.setProperty('--blur-width', 
                        `${this.config.absoluteOptions.blurContainer.width}px`);
                    blurContainer.style.setProperty('--blur-height', 
                        `${this.config.absoluteOptions.blurContainer.height}px`);
                    
                    // Add logging to verify the styles were set
                    console.log('Blur container styles:', {
                        width: blurContainer.style.getPropertyValue('--blur-width'),
                        height: blurContainer.style.getPropertyValue('--blur-height')
                    });
                }
                
                const { photoBack, photoCurrent, videoCurrent } = this.createMediaElements();
                
                blurContainer.appendChild(photoBack);
                blurContainer.appendChild(photoCurrent);
                blurContainer.appendChild(videoCurrent);
                wrapper.appendChild(blurContainer);
            } else {
                const { photoBack, photoCurrent, videoCurrent } = this.createMediaElements();
                
                wrapper.appendChild(photoBack);
                wrapper.appendChild(photoCurrent);
                wrapper.appendChild(videoCurrent);
            }
        } else {
            // Create media elements
            const { photoBack, photoCurrent, videoCurrent } = this.createMediaElements();
            
            // Handle absolute sizing
            if (this.config.absoluteOptions && this.config.absoluteOptions.enabled) {
                wrapper.classList.add('absolute');
                const size = this.config.absoluteOptions.size || 400;
                
                if (this.config.absoluteOptions.side === "horizontal") {
                    wrapper.style.width = `${size}px`;
                    wrapper.style.height = 'auto';
                } else {
                    wrapper.style.height = `${size}px`;
                    wrapper.style.width = 'auto';
                }
                
                // Create blur container if needed
                if (this.config.applyBlur) {
                    const blurContainer = document.createElement("div");
                    blurContainer.className = "blur-container";
                    
                    if (this.config.absoluteOptions.blurContainer) {
                        if (this.config.absoluteOptions.side === "horizontal") {
                            blurContainer.style.width = `${this.config.absoluteOptions.blurContainer.width}px`;
                            blurContainer.style.height = 'auto';
                        } else {
                            blurContainer.style.height = `${this.config.absoluteOptions.blurContainer.height}px`;
                            blurContainer.style.width = 'auto';
                        }
                    }
                    
                    blurContainer.appendChild(photoBack);
                    blurContainer.appendChild(photoCurrent);
                    blurContainer.appendChild(videoCurrent);
                    wrapper.appendChild(blurContainer);
                } else {
                    wrapper.appendChild(photoBack);
                    wrapper.appendChild(photoCurrent);
                    wrapper.appendChild(videoCurrent);
                }
            } else {
                wrapper.appendChild(photoBack);
                wrapper.appendChild(photoCurrent);
                wrapper.appendChild(videoCurrent);
            }
        }
        
        return wrapper;
    },

    displayMedia: function(media, wrapper) {
        const mediaType = this.getMediaType(media.key);
        
        if (mediaType === 'video' && this.config.video.enabled) {
            this.displayVideo(media, wrapper);
        } else {
            this.displayPhoto(media, wrapper);
        }
    },

    displayVideo: function(video, wrapper) {
        console.log("Preparing to show video:", video.key);
        const videoElement = wrapper.querySelector('.video-current');
        const photoCurrent = wrapper.querySelector('.photo-current');
        const photoBack = wrapper.querySelector('.photo-back');
        
        if (!videoElement) {
            console.error("Video element not found in wrapper");
            return;
        }
        
        // Hide photo elements
        if (photoCurrent) photoCurrent.style.display = 'none';
        if (photoBack) photoBack.style.display = 'none';
        
        // Configure video element with performance optimizations
        videoElement.src = this.file(`cache/${video.key}`);
        videoElement.autoplay = this.config.video.autoplay;
        videoElement.muted = this.config.video.muted;
        videoElement.loop = this.config.video.loop;
        videoElement.controls = this.config.video.controls;
        
        // Performance optimizations for smooth playback
        videoElement.setAttribute('playsinline', '');
        videoElement.setAttribute('webkit-playsinline', '');
        
        if (this.config.displayStyle === "absolute" && this.config.absoluteOptions?.enabled) {
            const size = this.config.absoluteOptions.size || 400;
            
            if (this.config.absoluteOptions.side === "horizontal") {
                videoElement.style.maxWidth = `${size}px`;
                videoElement.style.height = 'auto';
                videoElement.style.width = '100%';
            } else {
                videoElement.style.maxHeight = `${size}px`;
                videoElement.style.width = 'auto';
                videoElement.style.height = '100%';
            }
        } else {
            videoElement.style.width = '100%';
            videoElement.style.height = '100%';
            videoElement.style.objectFit = this.config.displayStyle === "wallpaper" || this.config.displayStyle === "fill" ? 'cover' : 'contain';
        }
        
        const newVideoElement = videoElement.cloneNode(true);
        videoElement.parentNode.replaceChild(newVideoElement, videoElement);
        
        newVideoElement.addEventListener('loadeddata', () => {
            console.log("Video loaded successfully:", video.key);
            newVideoElement.style.display = 'block';
            
            this.updateAttribution(video, wrapper);
            this.imagesDisplayed++;
            
            // If video is shorter than display duration and not looping,
            // schedule next media when video ends
            if (!this.config.video.loop) {
                newVideoElement.addEventListener('ended', () => {
                    console.log("Video ended, advancing to next media");
                    this.updateMedia();
                }, { once: true });
            }
        });
        
        newVideoElement.addEventListener('error', (e) => {
            console.error("Video failed to load:", video.key, e);
            this.updateMedia();
        });
        
        // Set up timer for next media (in case video is longer than display duration or loops)
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
            this.updateMedia();
        }, this.config.displayDurationSeconds * 1000);
    },


    displayPhoto: function(photo, wrapper) {
        console.log("Preparing to show photo:", photo.key);
        const hidden = new Image();
        hidden.src = this.file(`cache/${photo.key}`);
        console.log("Full image URL:", hidden.src);
        
        const videoElement = wrapper.querySelector('.video-current');
        if (videoElement) {
            videoElement.style.display = 'none';
            videoElement.pause();
        }
        
        hidden.onload = () => {
            const photoCurrent = wrapper.querySelector('.photo-current');
            const photoBack = wrapper.querySelector('.photo-back');
            
            if (photoCurrent) photoCurrent.style.display = 'block';
            if (photoBack) photoBack.style.display = 'block';
            
            if (photoCurrent) {
                // Prevent rotation by ensuring dimensions are set before transition
                if (this.config.displayStyle === "absolute") {
                    const aspectRatio = hidden.width / hidden.height;
                    const size = this.config.absoluteOptions.size;
    
                    if (this.config.absoluteOptions.side === "horizontal") {
                        const calculatedHeight = Math.round(size / aspectRatio);
                        // IMPORTANT: Set dimensions first
                        photoCurrent.style.width = `${size}px`;
                        photoCurrent.style.height = `${calculatedHeight}px`;
                    } else {
                        const calculatedWidth = Math.round(size * aspectRatio);
                        photoCurrent.style.height = `${size}px`;
                        photoCurrent.style.width = `${calculatedWidth}px`;
                    }
                }
    
                // Apply the background images after dimensions are set
                // Set back layer first
                if (photoBack) {
                    photoBack.style.backgroundImage = `url(${hidden.src})`;
                }
                
                // Then set front layer
                requestAnimationFrame(() => {
                    photoCurrent.style.backgroundImage = `url(${hidden.src})`;
                    
                    // Set background sizing
                    if (this.config.displayStyle === "absolute") {
                        photoCurrent.style.backgroundSize = "100% 100%";
                    } else if (this.config.displayStyle === "wallpaper" || this.config.displayStyle === "fill") {
                        photoCurrent.style.backgroundSize = "cover";
                    } else {
                        photoCurrent.style.backgroundSize = "contain";
                    }
    
                    // Update attribution immediately for all images
                    this.updateAttribution(photo, wrapper);
    
                    this.imagesDisplayed++;
                });
            }
    
            // Schedule next media
            if (this.timer) clearTimeout(this.timer);
            this.timer = setTimeout(() => {
                this.updateMedia();
            }, this.config.displayDurationSeconds * 1000);
        };
    
        hidden.onerror = () => {
            console.error("Failed to load image:", photo.key);
            this.updateMedia();
        };
    },

    file: function(relativePath) {
        // Helper function to convert module paths to absolute URLs
        relativePath = relativePath.replace(/^\//, '');
        return this.data.path + relativePath;
    },

    getStyles: function() {
        return ["MMM-S3Photos.css"];
    },

    scheduleNextPhoto: function() {
        Log.info("Scheduling next media");
        if (this.timer) {
            clearTimeout(this.timer);
        }
        
        this.timer = setTimeout(() => {
            this.updateMedia();
        }, this.config.displayDurationSeconds * 1000);
        
        // Show first media immediately
        if (!this.currentPhoto) {
            this.updateMedia();
        }
    },



    updateMedia: function() {
        console.log("Updating media");
        if (!this.photos || this.photos.length === 0) {
            console.log("No media available to display");
            return;
        }
    
        let nextIndex;
        switch (this.config.displayOrder) {
            case "random_dedupe":
                // Initialize tracking Set if it doesn't exist
                if (!this.shownPhotos) {
                    console.log("Initializing shown media tracking");
                    this.shownPhotos = new Set();
                }
    
                // Get array of available (unshown) indices
                const availableIndices = Array.from(Array(this.photos.length).keys())
                    .filter(i => !this.shownPhotos.has(i));
                
                console.log("Available media:", availableIndices.length, "Total media:", this.photos.length);
                
                // If no media are available, reset tracking
                if (availableIndices.length === 0) {
                    console.log("All media shown, resetting tracking");
                    this.shownPhotos.clear();
                    // Recalculate available indices
                    nextIndex = Math.floor(Math.random() * this.photos.length);
                } else {
                    // Pick random media from available indices
                    const randomAvailable = Math.floor(Math.random() * availableIndices.length);
                    nextIndex = availableIndices[randomAvailable];
                }
                
                console.log("Selected new media index:", nextIndex);
                this.shownPhotos.add(nextIndex);
                break;
            case "random":
                nextIndex = Math.floor(Math.random() * this.photos.length);
                break;
            case "newest_first":
                nextIndex = (this.currentIndex + 1) % this.photos.length;
                break;
            case "oldest_first":
                nextIndex = (this.currentIndex + 1) % this.photos.length;
                break;
            default:
                nextIndex = (this.currentIndex + 1) % this.photos.length;
        }
    
        this.currentIndex = nextIndex;
        const nextMedia = this.photos[nextIndex];
        console.log("Loading media:", nextMedia.key);
    
        // Update DOM
        const moduleWrapper = document.getElementById(this.identifier);
        if (moduleWrapper) {
            this.displayMedia(nextMedia, moduleWrapper);
        }
    },

    suspend: function() {
        // Handle module suspension
    },

    resume: function() {
        // Handle module resume
    },

    updateAttribution: function(photo, wrapper) {
        // Remove existing attributions
        const existingAttributions = wrapper.querySelectorAll('.attribution-container');
        Array.from(existingAttributions).forEach(attribution => attribution.remove());

        // Add new attribution if enabled
        if (this.config.attribution && this.config.attribution.enabled) {
            const folder = photo.key.split('/')[0];
            const text = this.config.attribution.attributions[folder];
            
            if (text) {
                const attributionContainer = document.createElement("div");
                attributionContainer.className = "attribution-container";
                attributionContainer.setAttribute('data-relative', 
                    this.config.attribution.relativeTo || 'display');
                
                const attribution = document.createElement("div");
                attribution.className = "attribution";
                attribution.textContent = text;

                if (this.config.attribution.position === "dynamic") {
                    if (!this.currentCorner) {
                        this.currentCorner = "top-left";
                    } else {
                        switch (this.currentCorner) {
                            case "top-left":
                                this.currentCorner = "top-right";
                                break;
                            case "top-right":
                                this.currentCorner = "bottom-right";
                                break;
                            case "bottom-right":
                                this.currentCorner = "bottom-left";
                                break;
                            case "bottom-left":
                                this.currentCorner = "top-left";
                                break;
                        }
                    }
                    attributionContainer.classList.add(this.currentCorner);
                } else {
                    attributionContainer.classList.add(this.config.attribution.corner || "bottom-right");
                }

                attributionContainer.appendChild(attribution);
                wrapper.appendChild(attributionContainer);
            }
        }
    }

});