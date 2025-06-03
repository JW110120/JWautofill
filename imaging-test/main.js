// --------------------------------------------------------------------------------
// Imports

const {filterEffect} = require("./pixelEffects.js");

// --------------------------------------------------------------------------------
// Native JavaScript extensions

const photoshop = require("photoshop");
const app = photoshop.app;
const core = photoshop.core;
const imaging = photoshop.imaging;

// --------------------------------------------------------------------------------
// Image constants

const kSRGBProfile = "sRGB IEC61966-2.1";

// --------------------------------------------------------------------------------

async function modalWrapper(handler, name) {
    try {
        return await core.executeAsModal(handler, {"commandNamer": name});
    } catch (e) {
        core.showAlert("Error: " + e);
    }
}

// --------------------------------------------------------------------------------
// Canvas thumbnail test

async function getImageThumbnail() {
    let imageElement = document.getElementById('thumbnailElement');

    /* Get the target for the thumbnail. We obtain pixels from the active document.
    If no layers are selected, then we get pixels from the entire document composite.
    If one or more layers are selected, then we get pixels from the first layer in the
    selection.
    Due to limitations in UXP 6.4 we must convert the returned pixel data to jpeg in order to
    assign as an image source for a UI element.
    This means that we specify that the returned image should use 8 bits per component and
    not include alpha. We request conversion to an sRGB colorspace because encodeImageData does
    not embed a color profile into the encoded jpeg stream.
    */
    let targetDocument = app.activeDocument;
    if (targetDocument == undefined) {throw "No open document"}

    let targetLayer = undefined;
    let activeLayers = targetDocument.activeLayers;
    if (activeLayers.length > 0) {
        targetLayer = activeLayers[0];
    };

    let options = {"documentID": targetDocument.id,
        "targetSize": {"height": 100, "width": 100},
        "componentSize": 8,
        "applyAlpha": true,
        "colorProfile": kSRGBProfile};
    if (targetLayer != undefined) {
        options["layerID"] = targetLayer.id;
    }

    let pixels = await imaging.getPixels(options);
    let jpegData = await imaging.encodeImageData({"imageData": pixels.imageData, "base64": true});

    let dataUrl = "data:image/jpeg;base64," + jpegData;
    imageElement.src = dataUrl;

    // Release image data immediately
    pixels.imageData.dispose();
}

// --------------------------------------------------------------------------------

async function addLayerMask() {
    let targetDocument = app.activeDocument;
    if (targetDocument == undefined) {throw "No open document"}

    let targetLayer = undefined;
    let activeLayers = targetDocument.activeLayers;
    if (activeLayers.length > 0) {
        targetLayer = activeLayers[0];
    };

    if (targetLayer == undefined) {throw "No layer selected"}
    
    if (targetLayer.isBackgroundLayer) {throw "Cannot add Layer Mask to Background layer."};
    
    // Create a gray scale image for the mask
    const width = 30;
    const height = 40;
    const pixelCount = width * height;
    arrayBuffer = new Uint8Array(pixelCount);
    for (let i = 0; i < pixelCount; ++i) {
        arrayBuffer[i] = 127;
    }
    
    let options = {"width": width,
        "height": height,
        "components": 1,
        "chunky": false,
        "colorProfile": "Generic Gray Profile",
        colorSpace: "Grayscale"};
    let image = await imaging.createImageDataFromBuffer(arrayBuffer, options);
    
    await imaging.putLayerMask({"documentID": targetDocument.id,
        "layerID": targetLayer.id,
        "imageData": image});

    // Release image data immediately
    image.dispose();
}

// --------------------------------------------------------------------------------

async function setSelection() {
    let targetDocument = app.activeDocument;

    if (targetDocument == undefined) {throw "No open document"}
    
    // Create a gray scale image for the selection
    const width = 30;
    const height = 40;
    const pixelCount = width * height;
    arrayBuffer = new Uint8Array(pixelCount);
    for (let i = 0; i < pixelCount; ++i) {
        arrayBuffer[i] = 255;
    }
    
    let options = {"width": width,
        "height": height,
        "components": 1,
        "chunky": false,
        "colorProfile": "Generic Gray Profile",
        colorSpace: "Grayscale"};
    let image = await imaging.createImageDataFromBuffer(arrayBuffer, options);
    
    await imaging.putSelection({"documentID": targetDocument.id,
        "imageData": image});

    // Release image data immediately
    image.dispose();
}

// --------------------------------------------------------------------------------
// HTML event handlers

function setElementHandler(elementId, handlerKind, handler) {
    let element = document.getElementById(elementId);
    if (element != undefined) {
        element[handlerKind] = handler;
    }
}

function setOnclickHandler(elementId, handler) {
    setElementHandler(elementId, "onclick", handler);
}

setOnclickHandler("radialDesaturation", function () { filterEffect("desaturation") });
setOnclickHandler("redFilter", function () {  filterEffect("redChannel") });
setOnclickHandler("addLayerMask", function () { modalWrapper(addLayerMask, "Add Layer Mask")});
setOnclickHandler("setSelection", function () { modalWrapper(setSelection, "Set Selection")});
setOnclickHandler("getThumbnail", function () { modalWrapper(getImageThumbnail, "Get Thumbnail")});
