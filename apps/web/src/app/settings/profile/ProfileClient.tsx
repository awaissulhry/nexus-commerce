"use client";

import { useState, useTransition } from "react";
import { saveProfile, changePassword } from "./actions";

interface ProfileData {
  displayName: string;
  email: string;
  avatarUrl: string;
  hasPassword: boolean;
}

interface Props {
  profile: ProfileData | null;
}

export default function ProfileClient({ profile }: Props) {
  const [isPending, startTransition] = useTransition();
  const [profileMsg, setProfileMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);
  const [passwordMsg, setPasswordMsg] = useState<{ type: "success" | "error"; text: string } | null>(null);

  const defaults: ProfileData = profile || {
    displayName: "",
    email: "",
    avatarUrl: "",
    hasPassword: false,
  };

  const handleProfileSubmit = (formData: FormData) => {
    setProfileMsg(null);
    startTransition(async () => {
      try {
        const result = await saveProfile(formData);
        if (result.success) {
          setProfileMsg({ type: "success", text: "Profile updated successfully!" });
        }
      } catch {
        setProfileMsg({ type: "error", text: "Failed to update profile" });
      }
    });
  };

  const handlePasswordSubmit = (formData: FormData) => {
    setPasswordMsg(null);
    startTransition(async () => {
      try {
        const result = await changePassword(formData);
        if (result.success) {
          setPasswordMsg({ type: "success", text: "Password changed successfully!" });
        } else {
          setPasswordMsg({ type: "error", text: result.error || "Failed to change password" });
        }
      } catch {
        setPasswordMsg({ type: "error", text: "Failed to change password" });
      }
    });
  };

  return (
    <div className="max-w-2xl space-y-6">
      {/* Profile Information */}
      <form action={handleProfileSubmit}>
        {profileMsg && (
          <div
            className={`mb-4 px-4 py-3 rounded-lg text-sm ${
              profileMsg.type === "success"
                ? "bg-green-50 text-green-800 border border-green-200"
                : "bg-red-50 text-red-800 border border-red-200"
            }`}
          >
            {profileMsg.type === "success" ? "✅" : "❌"} {profileMsg.text}
          </div>
        )}

        <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-4">Profile Information</h3>

          <div className="space-y-4">
            {/* Avatar Preview */}
            <div className="flex items-center gap-4">
              <div className="w-16 h-16 rounded-full bg-gray-200 flex items-center justify-center overflow-hidden border-2 border-gray-300">
                {defaults.avatarUrl ? (
                  // eslint-disable-next-line @next/next/no-img-element
                  <img
                    src={defaults.avatarUrl}
                    alt="Avatar"
                    className="w-full h-full object-cover"
                  />
                ) : (
                  <span className="text-2xl text-gray-400">👤</span>
                )}
              </div>
              <div className="flex-1">
                <label htmlFor="avatarUrl" className="block text-sm font-medium text-gray-700 mb-1">
                  Avatar URL
                </label>
                <input
                  id="avatarUrl"
                  name="avatarUrl"
                  type="url"
                  defaultValue={defaults.avatarUrl}
                  placeholder="https://example.com/avatar.jpg"
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>

            <div>
              <label htmlFor="displayName" className="block text-sm font-medium text-gray-700 mb-1">
                Display Name
              </label>
              <input
                id="displayName"
                name="displayName"
                type="text"
                defaultValue={defaults.displayName}
                placeholder="Your Name"
                className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
              />
            </div>

            <div>
              <label htmlFor="email" className="block text-sm font-medium text-gray-700 mb-1">
                Email Address
              </label>
              <input
                id="email"
                name="email"
                type="email"
                defaultValue={defaults.email}
                disabled
                className="w-full px-3 py-2 text-sm border border-gray-200 rounded-lg bg-gray-50 text-gray-500 cursor-not-allowed"
              />
              <p className="text-xs text-gray-400 mt-1">
                Email cannot be changed from this page. Contact support for email changes.
              </p>
            </div>
          </div>

          <div className="flex justify-end mt-6">
            <button
              type="submit"
              disabled={isPending}
              className="px-6 py-2.5 text-sm font-medium bg-blue-600 text-white rounded-lg hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isPending ? "Saving…" : "Save Profile"}
            </button>
          </div>
        </div>
      </form>

      {/* Change Password */}
      <form action={handlePasswordSubmit}>
        {passwordMsg && (
          <div
            className={`mb-4 px-4 py-3 rounded-lg text-sm ${
              passwordMsg.type === "success"
                ? "bg-green-50 text-green-800 border border-green-200"
                : "bg-red-50 text-red-800 border border-red-200"
            }`}
          >
            {passwordMsg.type === "success" ? "✅" : "❌"} {passwordMsg.text}
          </div>
        )}

        <div className="bg-white rounded-lg shadow border border-gray-200 p-6">
          <h3 className="text-sm font-semibold text-gray-900 mb-1">Change Password</h3>
          <p className="text-xs text-gray-500 mb-4">
            {defaults.hasPassword
              ? "Enter your current password and choose a new one."
              : "No password set yet. Create one to secure your account."}
          </p>

          <div className="space-y-4">
            {defaults.hasPassword && (
              <div>
                <label htmlFor="currentPassword" className="block text-sm font-medium text-gray-700 mb-1">
                  Current Password
                </label>
                <input
                  id="currentPassword"
                  name="currentPassword"
                  type="password"
                  required={defaults.hasPassword}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            )}

            <div className="grid grid-cols-2 gap-4">
              <div>
                <label htmlFor="newPassword" className="block text-sm font-medium text-gray-700 mb-1">
                  New Password
                </label>
                <input
                  id="newPassword"
                  name="newPassword"
                  type="password"
                  required
                  minLength={8}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
              <div>
                <label htmlFor="confirmPassword" className="block text-sm font-medium text-gray-700 mb-1">
                  Confirm Password
                </label>
                <input
                  id="confirmPassword"
                  name="confirmPassword"
                  type="password"
                  required
                  minLength={8}
                  className="w-full px-3 py-2 text-sm border border-gray-300 rounded-lg focus:ring-2 focus:ring-blue-500 focus:border-blue-500"
                />
              </div>
            </div>

            <p className="text-xs text-gray-400">
              Password must be at least 8 characters long.
            </p>
          </div>

          <div className="flex justify-end mt-6">
            <button
              type="submit"
              disabled={isPending}
              className="px-6 py-2.5 text-sm font-medium bg-orange-600 text-white rounded-lg hover:bg-orange-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
            >
              {isPending ? "Changing…" : "Change Password"}
            </button>
          </div>
        </div>
      </form>

      {/* Security Info */}
      <div className="bg-gray-50 border border-gray-200 rounded-lg p-4">
        <p className="text-xs text-gray-600">
          🔒 <strong>Security:</strong> Passwords are hashed before storage and never stored in plain text.
          For maximum security, use a unique password that you don&apos;t use on other sites.
        </p>
      </div>
    </div>
  );
}
