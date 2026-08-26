# Keep the serializable models the sync and settings layers round-trip.
-keepclassmembers class dev.aether.browser.** {
    *** Companion;
}
-keepclasseswithmembers class dev.aether.browser.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-dontwarn kotlinx.serialization.**
