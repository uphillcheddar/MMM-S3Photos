Module.register("MMM-S3Photos", {
    defaults: {
        syncTimeHours: 1, // How often to run the Lambda function and run the delta logic
        cacheLifeDays: 0, // 0 = never clean cache, >0 = days between cache purges
        displayDurationSeconds: 30, // How long (seconds) to display each photo
        displayStyle: "wallpaper", // "wallpaper", "fit-region", "absolute"
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
    },

    notificationReceived: function(notification, payload, sender) {
        if (notification === "ALL_MODULES_STARTED") {
            Log.info(this.name + " received ALL_MODULES_STARTED notification");
            this.moduleLoaded = true;
            this.initialize();
        } else if (notification === "GPHOTO_UPLOAD" && this.config.selfieUploads) {
            Log.info("Received new photo notification:", payload);
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

        Log.info("Module received socket notification:", notification);
        
        if (notification === "PHOTOS_UPDATED") {
            if (Array.isArray(payload) && payload.length > 0) {
                Log.info("Received photos array with length:", payload.length);
                this.photos = payload;
                this.errorMessage = null;  // Clear any previous error
                this.loaded = true;
                this.updateDom(0);
            } else {
                Log.warn("Received empty or invalid photos array");
                this.photos = [];
                this.errorMessage = "No photos available";  // Set error message
                this.loaded = true;
                this.updateDom(0);
            }
        } else if (notification === "PHOTOS_ERROR") {
            Log.error("Error received from node helper:", payload);
            this.loaded = true;
            this.errorMessage = typeof payload === 'string' ? payload : 'Unknown error occurred';
            this.updateDom(0);
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

    getNextPhoto: function() {
        if (this.photos.length === 0) {
            return null;
        }

        if (this.config.displayOrder === "newest_first") {
            // Sort once and maintain index
            if (!this.sortedPhotos) {
                this.sortedPhotos = [...this.photos].sort((a, b) => new Date(b.lastModified) - new Date(a.lastModified));
                this.currentIndex = 0;
            }
            const photo = this.sortedPhotos[this.currentIndex];
            this.currentIndex = (this.currentIndex + 1) % this.sortedPhotos.length;
            return photo;

        } else if (this.config.displayOrder === "oldest_first") {
            // Sort once and maintain index
            if (!this.sortedPhotos) {
                this.sortedPhotos = [...this.photos].sort((a, b) => new Date(a.lastModified) - new Date(b.lastModified));
                this.currentIndex = 0;
            }
            const photo = this.sortedPhotos[this.currentIndex];
            this.currentIndex = (this.currentIndex + 1) % this.sortedPhotos.length;
            return photo;

        } else if (this.config.displayOrder === "random_dedupe") {
            const remainingPhotos = this.photos.filter(photo => 
                !Array.from(this.displayedPhotos).some(displayed => 
                    displayed.url === photo.url
                )
            );
            if (remainingPhotos.length === 0) {
                this.displayedPhotos.clear();
                return this.getNextPhoto();
            }
            const photo = remainingPhotos[Math.floor(Math.random() * remainingPhotos.length)];
            this.displayedPhotos.add(photo);
            return photo;

        } else { // "random"
            return this.photos[Math.floor(Math.random() * this.photos.length)];
        }
    },

    getAttributionText: function(photoUrl) {
        const parts = photoUrl.split('/');
        const subfolder = parts[parts.length - 2] || '';
        return this.config.attribution.attributions[subfolder] || "";
    },

    getAttributionCorner: function() {
        if (this.config.attribution.position === "dynamic") {
            const corners = ["top-left", "top-right", "bottom-left", "bottom-right"];
            return corners[Math.floor(Math.random() * corners.length)];
        }
        return this.config.attribution.corner;
    },

    getDom: function() {
        const wrapper = document.createElement("div");
        wrapper.className = "MMM-S3Photos";

        if (!this.moduleLoaded) {
            wrapper.innerHTML = "Initializing...";
            return wrapper;
        }

        if (!this.loaded) {
            Log.info("Showing loading state");
            wrapper.innerHTML = "Loading photos...";
            
            if (this.moduleLoaded && !this.loadingTimeout) {
                this.loadingTimeout = setTimeout(() => {
                    Log.warn("Loading timeout reached, forcing reload");
                    this.loadingTimeout = null;
                    this.getPhotos();
                }, 10000);
            }
            return wrapper;
        }

        if (this.loadingTimeout) {
            clearTimeout(this.loadingTimeout);
            this.loadingTimeout = null;
        }

        if (this.errorMessage) {
            Log.error("Showing error state:", this.errorMessage);
            wrapper.innerHTML = "Error: " + this.errorMessage;
            return wrapper;
        }

        if (!this.photos || this.photos.length === 0) {
            Log.warn("No photos available");
            wrapper.innerHTML = "No photos available";
            return wrapper;
        }

        const photo = this.getNextPhoto();
        Log.info("Displaying photo:", photo);
        
        if (photo && photo.url) {
            const imageUrl = this.file(photo.url);

            // Add display style class first
            wrapper.classList.add(this.config.displayStyle);

            // 1. Create blur background first (backmost layer)
            if (this.config.applyBlur) {
                if (this.config.displayStyle === "absolute" && this.config.absoluteOptions.enabled) {
                    const blurContainer = document.createElement("div");
                    blurContainer.className = "blur-container";
                    
                    wrapper.style.setProperty('--blur-width', 
                        `${this.config.absoluteOptions.blurContainer.width}px`);
                    wrapper.style.setProperty('--blur-height', 
                        `${this.config.absoluteOptions.blurContainer.height}px`);

                    const blurBackground = document.createElement("div");
                    blurBackground.className = "blur-background";
                    blurBackground.style.backgroundImage = `url("${imageUrl}")`;
                    
                    blurContainer.appendChild(blurBackground);
                    wrapper.appendChild(blurContainer); // Changed from insertBefore
                } else {
                    const blurBackground = document.createElement("div");
                    blurBackground.className = "blur-background";
                    blurBackground.style.backgroundImage = `url("${imageUrl}")`;
                    wrapper.appendChild(blurBackground); // Changed from insertBefore
                }
            }

            // 2. Create container for the main image (middle layer)
            const imageContainer = document.createElement("div");
            imageContainer.className = "image-container";
            imageContainer.style.backgroundImage = `url("${imageUrl}")`;
            
            // Create an actual img element to get dimensions
            const img = document.createElement("img");
            img.src = imageUrl;
            img.style.display = "none";
            
            // Create attribution but keep it hidden initially
            let attribution = null;
            if (this.config.attribution && this.config.attribution.enabled) {
                attribution = document.createElement("div");
                const folder = photo.key.split('/')[0];
                const text = this.config.attribution.attributions[folder];
                
                if (text) {
                    const corner = this.config.attribution.position === "dynamic" 
                        ? this.getAttributionCorner()
                        : this.config.attribution.corner;
                        
                    Log.info(`Creating attribution - Text: ${text}, Corner: ${corner}, RelativeTo: ${this.config.attribution.relativeTo}`);
                    
                    attribution.className = `attribution ${corner} hidden`;
                    attribution.dataset.relative = this.config.attribution.relativeTo;
                    attribution.textContent = text;
                    imageContainer.appendChild(attribution);
                    
                    Log.info(`Attribution element created - Class: ${attribution.className}, Dataset: ${JSON.stringify(attribution.dataset)}`);
                }
            }

            img.onload = () => {
                const aspectRatio = img.naturalWidth / img.naturalHeight;
                
                // Set the aspect ratio as a CSS variable
                wrapper.style.setProperty('--image-ratio', aspectRatio);
                
                // If using absolute sizing, add the appropriate class and set size
                if (this.config.displayStyle === "absolute" && this.config.absoluteOptions.enabled) {
                    wrapper.classList.add(this.config.absoluteOptions.side); // Add horizontal/vertical class
                    
                    if (this.config.absoluteOptions.side === "horizontal") {
                        wrapper.style.setProperty('--absolute-width', `${this.config.absoluteOptions.size}px`);
                        // Calculate height based on aspect ratio
                        const height = this.config.absoluteOptions.size / aspectRatio;
                        imageContainer.style.height = `${height}px`;
                    } else {
                        wrapper.style.setProperty('--absolute-height', `${this.config.absoluteOptions.size}px`);
                        // Calculate width based on aspect ratio
                        const width = this.config.absoluteOptions.size * aspectRatio;
                        imageContainer.style.width = `${width}px`;
                    }
                }
                
                Log.info(`Image natural dimensions - Width: ${img.naturalWidth}, Height: ${img.naturalHeight}, Aspect Ratio: ${aspectRatio}`);
                
                // Wait for next frame to ensure DOM is ready
                requestAnimationFrame(() => {
                    // Force a reflow and ensure we have valid dimensions
                    document.body.offsetHeight;
                    
                    // Try multiple ways to get valid container dimensions
                    const containerWidth = imageContainer.offsetWidth || wrapper.offsetWidth || window.innerWidth;
                    const containerHeight = imageContainer.offsetHeight || wrapper.offsetHeight || window.innerHeight;
                    Log.info(`Container dimensions - Width: ${containerWidth}, Height: ${containerHeight}`);
                    
                    if (containerWidth === 0 || containerHeight === 0) {
                        Log.error('Invalid container dimensions, using fallback values');
                        return;
                    }
                    
                    let imageWidth, imageHeight;
                    if (containerWidth / containerHeight > aspectRatio) {
                        imageHeight = containerHeight;
                        imageWidth = imageHeight * aspectRatio;
                        Log.info(`Using container height as base - Calculated dimensions - Width: ${imageWidth}, Height: ${imageHeight}`);
                    } else {
                        imageWidth = containerWidth;
                        imageHeight = imageWidth / aspectRatio;
                        Log.info(`Using container width as base - Calculated dimensions - Width: ${imageWidth}, Height: ${imageHeight}`);
                    }
                    
                    // Ensure we have valid dimensions before proceeding
                    if (imageWidth > 0 && imageHeight > 0) {
                        Log.info(`Setting CSS variables - Image Width: ${imageWidth}px, Image Height: ${imageHeight}px`);
                        wrapper.style.setProperty('--image-width', `${imageWidth}px`);
                        wrapper.style.setProperty('--image-height', `${imageHeight}px`);
                        imageContainer.style.setProperty('--image-width', `${imageWidth}px`);
                        imageContainer.style.setProperty('--image-height', `${imageHeight}px`);
                        
                        if (attribution) {
                            const computedStyle = window.getComputedStyle(attribution);
                            Log.info(`Attribution data-relative: ${attribution.dataset.relative}, class: ${attribution.className}`);
                            
                            // Calculate expected position
                            const corner = attribution.className.match(/(top|bottom)-(left|right)/)[0];
                            const verticalOffset = (100 - imageHeight) / 2;
                            const horizontalOffset = (100 - imageWidth) / 2;
                            Log.info(`Attribution calculated offsets - Vertical: ${verticalOffset}, Horizontal: ${horizontalOffset}, Corner: ${corner}`);
                            
                            // Use RAF for smooth transition
                            requestAnimationFrame(() => {
                                attribution.classList.remove('hidden');
                                // Log position after unhiding
                                const newComputedStyle = window.getComputedStyle(attribution);
                                Log.info(`Attribution position after unhiding - Top: ${newComputedStyle.top}, Left: ${newComputedStyle.left}, Bottom: ${newComputedStyle.bottom}, Right: ${newComputedStyle.right}`);
                            });
                        }
                    } else {
                        Log.error('Failed to calculate valid image dimensions');
                    }
                });
                
                img.remove();
                Log.info('Image load handler complete');
            };
            
            imageContainer.appendChild(img);

            // Important: Append the imageContainer to the wrapper
            wrapper.appendChild(imageContainer);

            // Set absolute size if needed
            if (this.config.displayStyle === "absolute" && this.config.absoluteOptions.enabled) {
                if (this.config.absoluteOptions.side === "horizontal") {
                    wrapper.style.setProperty('--absolute-width', 
                        `${this.config.absoluteOptions.size}px`);
                } else {
                    wrapper.style.setProperty('--absolute-height', 
                        `${this.config.absoluteOptions.size}px`);
                }
            }
        } else {
            wrapper.innerHTML = "Error loading photo";
        }

        return wrapper;
    },

    file: function(relativePath) {
        // Helper function to convert module paths to absolute URLs
        relativePath = relativePath.replace(/^\//, '');
        return this.data.path + '/' + relativePath;
    },

    getStyles: function() {
        return ["MMM-S3Photos.css"];
    },

    scheduleNextPhoto: function() {
        if (this.displayTimer) {
            clearTimeout(this.displayTimer);
        }
        
        this.displayTimer = setTimeout(() => {
            this.updateDom(1000); // 1 second transition
            this.scheduleNextPhoto();
        }, this.config.displayDurationSeconds * 1000);
    },

    suspend: function() {
        // Handle module suspension
    },

    resume: function() {
        // Handle module resume
    }

});