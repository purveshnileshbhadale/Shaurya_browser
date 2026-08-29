# Keep the serializable models the sync and settings layers round-trip.
-keepclassmembers class dev.shaurya.browser.** {
    *** Companion;
}
-keepclasseswithmembers class dev.shaurya.browser.** {
    kotlinx.serialization.KSerializer serializer(...);
}
-dontwarn kotlinx.serialization.**
